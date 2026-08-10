import * as THREE from "three";
import { ConvexGeometry } from "three/addons/geometries/ConvexGeometry.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import {
  GAME,
  WORLD_FLOOR_COLOR,
  WORLD_FLOOR_VISIBLE,
  WORLD_BOXES,
  WORLD_HULLS,
  WORLD_MODELS,
  WORLD_SIZE,
  worldHullHeightAt,
  worldHullFootprint,
  type PaintPart,
  type PaintStroke,
  type PlayerPaintState,
  type PlayerState,
  type Pose,
  type ServerSnapshot
} from "@mechfall/shared";
import type { InputController } from "./InputController.ts";

interface PaintSurface {
  mesh: THREE.Mesh;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  material: THREE.MeshStandardMaterial;
  uvPaintLayer?: boolean;
  transparentLayer?: boolean;
}

interface Avatar {
  root: THREE.Group;
  serverPosition: THREE.Vector3;
  target: THREE.Vector3;
  snapshotReceivedAt: number;
  targetYaw: number;
  baseColor: string;
  paintSurfaces: Map<PaintPart, PaintSurface>;
  strokes: PaintStroke[];
  procedural: boolean;
  body?: THREE.Mesh;
  head?: THREE.Mesh;
  leftArm?: THREE.Mesh;
  rightArm?: THREE.Mesh;
  leftLeg?: THREE.Mesh;
  rightLeg?: THREE.Mesh;
  visual?: THREE.Object3D;
  visualBasePosition?: THREE.Vector3;
  bodyPitch?: number;
  bodyPitchApplied?: number;
  bodyPitchBones?: Array<{ bone: THREE.Object3D; weight: number }>;
  locomotionArmBones?: Partial<Record<LocomotionArmBoneName, THREE.Object3D>>;
  rightUpperArmBone?: THREE.Object3D;
  rightLowerArmBone?: THREE.Object3D;
  rightHandBone?: THREE.Object3D;
  mixer?: THREE.AnimationMixer;
  actions?: Map<string, THREE.AnimationAction>;
  activeAction?: THREE.AnimationAction;
  activeAnimation?: string;
  hunterMark: THREE.Group;
  weapon: THREE.Group;
  muzzle: THREE.Object3D;
  weaponBasePosition: THREE.Vector3;
  recoilUntil: number;
  whistleRing: THREE.Mesh;
  state: PlayerState;
}

interface CharacterAlignment {
  scale: number;
  position: THREE.Vector3;
}

export class WorldRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(58, 1, 0.1, 110);
  private readonly clock = new THREE.Clock();
  private readonly avatars = new Map<string, Avatar>();
  private readonly sampleSurfaces: THREE.Object3D[] = [];
  private readonly collisionDebugRoot = new THREE.Group();
  private readonly collisionDebugFillMaterial = new THREE.MeshBasicMaterial({
    color: "#ff2438",
    transparent: true,
    opacity: 0.16,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  private readonly collisionDebugLineMaterial = new THREE.LineBasicMaterial({
    color: "#ff1028",
    transparent: true,
    opacity: 0.95,
    depthTest: false
  });
  private readonly collisionDebugModelCenters = new Map<string, THREE.Vector3>();
  private readonly collisionDebugModelsLoading = new Set<string>();
  private readonly collisionDebugModelsLoaded = new Set<string>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pendingPaint = new Map<string, PaintStroke[]>();
  private readonly beforeRenderTasks = new Set<() => void>();
  private readonly attachedVisualTarget = new THREE.Vector3();
  private readonly attachedVisualOffset = new THREE.Vector3();
  private readonly hunterArmDirection = new THREE.Vector3();
  private readonly hunterArmLocalDirection = new THREE.Vector3();
  private readonly hunterArmRestDirection = new THREE.Vector3();
  private readonly hunterArmQuaternion = new THREE.Quaternion();
  private readonly hunterHandPosition = new THREE.Vector3();
  private readonly hunterWeaponGripOffset = new THREE.Vector3();
  private readonly hunterWeaponFineOffset = new THREE.Vector3();
  private firstPersonHunterActive = false;
  private selfId = "";
  private roundPhase: ServerSnapshot["round"]["phase"] = "waiting";
  private input?: InputController;
  private running = true;
  private paintView = false;
  private paintOrbitYaw = 0;
  private paintOrbitPitch = 0;
  private cameraDistance = 5.4;
  private targetCameraDistance = 5.4;
  private readonly cameraFocus = new THREE.Vector3();
  private cameraOrbitYaw = 0;
  private cameraOrbitPitch = -0.2;
  private cameraRigInitialized = false;
  private characterTemplate?: THREE.Group;
  private characterAnimations: THREE.AnimationClip[] = [];
  private characterAlignment?: CharacterAlignment;
  private shotgunTemplate?: THREE.Group;
  private readonly characterLoadPromise: Promise<void>;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.canvas = this.renderer.domElement;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    container.append(this.canvas);

    this.scene.background = new THREE.Color("#b8c4ba");
    this.scene.fog = new THREE.FogExp2("#b8c4ba", 0.018);
    this.scene.add(this.camera);
    this.collisionDebugRoot.name = "collision-debug";
    this.collisionDebugRoot.visible = false;
    this.scene.add(this.collisionDebugRoot);
    this.buildLighting();
    this.buildWorld();
    this.characterLoadPromise = this.loadCharacterModel();
    void this.loadShotgunModel();
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.animate();
  }

  bindInput(input: InputController): void {
    this.input = input;
  }

  toggleCollisionDebug(): boolean {
    this.collisionDebugRoot.visible = !this.collisionDebugRoot.visible;
    if (this.collisionDebugRoot.visible) {
      for (const worldModel of WORLD_MODELS) {
        const center = this.collisionDebugModelCenters.get(worldModel.id);
        if (center) void this.loadModelCollisionDebug(worldModel, center);
      }
    }
    return this.collisionDebugRoot.visible;
  }

  scheduleBeforeRender(task: () => void): void {
    this.beforeRenderTasks.add(task);
  }

  cancelBeforeRender(task: () => void): void {
    this.beforeRenderTasks.delete(task);
  }

  waitForCharacterModel(): Promise<void> {
    return this.characterLoadPromise;
  }

  measureSelfPaintCoverage(color: string): { painted: number; total: number; ratio: number } {
    const avatar = this.avatars.get(this.selfId);
    if (!avatar) return { painted: 0, total: 0, ratio: 0 };
    const target = Number.parseInt(color.replace("#", ""), 16);
    const targetRed = (target >> 16) & 0xff;
    const targetGreen = (target >> 8) & 0xff;
    const targetBlue = target & 0xff;
    let painted = 0;
    let total = 0;

    for (const surface of avatar.paintSurfaces.values()) {
      const pixels = surface.context.getImageData(0, 0, surface.canvas.width, surface.canvas.height).data;
      const geometry = surface.mesh.geometry;
      const uvs = geometry.getAttribute("uv");
      const positions = geometry.getAttribute("position");
      const faceCount = geometry.index ? Math.floor(geometry.index.count / 3) : Math.floor(positions.count / 3);
      for (let face = 0; face < faceCount; face += 1) {
        const vertices = paintFaceVertices(geometry, face);
        const u = (uvs.getX(vertices[0]) + uvs.getX(vertices[1]) + uvs.getX(vertices[2])) / 3;
        const v = (uvs.getY(vertices[0]) + uvs.getY(vertices[1]) + uvs.getY(vertices[2])) / 3;
        const x = THREE.MathUtils.clamp(Math.floor(u * surface.canvas.width), 0, surface.canvas.width - 1);
        const y = THREE.MathUtils.clamp(Math.floor((1 - v) * surface.canvas.height), 0, surface.canvas.height - 1);
        total += 1;
        let paintedFace = false;
        for (let offsetY = -1; offsetY <= 1 && !paintedFace; offsetY += 1) {
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            const sampleX = THREE.MathUtils.clamp(x + offsetX, 0, surface.canvas.width - 1);
            const sampleY = THREE.MathUtils.clamp(y + offsetY, 0, surface.canvas.height - 1);
            const offset = (sampleY * surface.canvas.width + sampleX) * 4;
            if (
              Math.abs(pixels[offset]! - targetRed) <= 3
              && Math.abs(pixels[offset + 1]! - targetGreen) <= 3
              && Math.abs(pixels[offset + 2]! - targetBlue) <= 3
            ) {
              paintedFace = true;
              break;
            }
          }
        }
        if (paintedFace) painted += 1;
      }
    }
    return { painted, total, ratio: total > 0 ? painted / total : 0 };
  }

  paintEverySelfFaceForTest(color: string, size: number): number {
    const avatar = this.avatars.get(this.selfId);
    if (!avatar) return 0;
    let strokes = 0;
    for (const [part, surface] of avatar.paintSurfaces) {
      const geometry = surface.mesh.geometry;
      const positions = geometry.getAttribute("position");
      const uvs = geometry.getAttribute("uv");
      const faceCount = geometry.index ? Math.floor(geometry.index.count / 3) : Math.floor(positions.count / 3);
      for (let face = 0; face < faceCount; face += 1) {
        const vertices = paintFaceVertices(geometry, face);
        if (surface.uvPaintLayer) {
          fillPaintFace(surface, vertices, color);
          strokes += 1;
          continue;
        }
        this.applyPaintStroke(this.selfId, {
          part,
          face,
          u: (uvs.getX(vertices[0]) + uvs.getX(vertices[1]) + uvs.getX(vertices[2])) / 3,
          v: (uvs.getY(vertices[0]) + uvs.getY(vertices[1]) + uvs.getY(vertices[2])) / 3,
          color,
          size
        });
        strokes += 1;
      }
    }
    return strokes;
  }

  setPaintView(active: boolean): void {
    this.paintView = active;
    const targetPixelRatio = Math.min(window.devicePixelRatio, active ? 1.25 : 1.75);
    if (this.renderer.getPixelRatio() !== targetPixelRatio) {
      this.renderer.setPixelRatio(targetPixelRatio);
      this.resize();
    }
    if (active) {
      // Preserve the normal behind-the-player view when opening paint mode.
      this.paintOrbitYaw = 0;
      this.paintOrbitPitch = 0;
    }
  }

  orbitPaintCamera(deltaX: number, deltaY: number): void {
    if (!this.paintView) return;
    this.paintOrbitYaw -= deltaX * 0.008;
    this.paintOrbitPitch = Math.max(-0.5, Math.min(0.72, this.paintOrbitPitch - deltaY * 0.004));
  }

  zoomCamera(deltaY: number): void {
    if (!Number.isFinite(deltaY) || deltaY === 0) return;
    const zoomDelta = Math.sign(deltaY) * THREE.MathUtils.clamp(Math.abs(deltaY) * 0.0045, 0.1, 0.48);
    this.targetCameraDistance = THREE.MathUtils.clamp(this.targetCameraDistance + zoomDelta, 2.8, 15);
  }

  applySnapshot(snapshot: ServerSnapshot): void {
    this.selfId = snapshot.selfId;
    this.roundPhase = snapshot.round.phase;
    const liveIds = new Set(snapshot.players.map((player) => player.id));
    for (const [id, avatar] of this.avatars) {
      if (!liveIds.has(id)) {
        this.scene.remove(avatar.root);
        this.avatars.delete(id);
      }
    }

    for (const player of snapshot.players) {
      let avatar = this.avatars.get(player.id);
      if (!avatar) {
        avatar = this.createAvatar(player);
        avatar.root.position.set(player.position.x, player.position.y, player.position.z);
        this.avatars.set(player.id, avatar);
        this.scene.add(avatar.root);
      }
      avatar.serverPosition.set(player.position.x, player.position.y, player.position.z);
      avatar.snapshotReceivedAt = performance.now();
      avatar.targetYaw = player.yaw;
      avatar.state = player;
      avatar.root.scale.setScalar(player.role === "hunter" ? GAME.hunterVisualScale : 1);
      if (avatar.baseColor !== player.color) {
        avatar.baseColor = player.color;
        this.redrawPaint(avatar);
      }
      for (const surface of avatar.paintSurfaces.values()) {
        surface.material.roughness = 1;
        surface.material.metalness = 0;
      }
      avatar.root.visible = player.alive;
      avatar.hunterMark.visible = player.role === "hunter";
      avatar.weapon.visible = player.role === "hunter" && player.alive;
      this.setPose(avatar, player.pose);
    }
  }

  getSelf(): PlayerState | undefined {
    return this.avatars.get(this.selfId)?.state;
  }

  sampleCenterColor(): string | undefined {
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hits = this.raycaster.intersectObjects(this.sampleSurfaces, false);
    for (const hit of hits) {
      const color = hit.object.userData.sampleColor as string | undefined;
      if (color) return color;
    }
    return undefined;
  }

  sampleScreenColor(clientX: number, clientY: number): string | undefined {
    this.setRayFromScreen(clientX, clientY);
    // Raycast every visible mesh instead of just the large level blocks. This
    // makes the pipette pick the exact mesh the player clicked (leaf, pipe,
    // banner, painted player, etc.), while returning its unlit material color.
    const hits = this.raycaster.intersectObjects(this.scene.children, true);
    for (const hit of hits) {
      if (!isVisibleInScene(hit.object)) continue;
      const color = this.sampleHitColor(hit);
      if (color) return color;
    }
    return undefined;
  }

  private sampleHitColor(hit: THREE.Intersection<THREE.Object3D>): string | undefined {
    if (!(hit.object instanceof THREE.Mesh)) return undefined;

    for (const avatar of this.avatars.values()) {
      for (const surface of avatar.paintSurfaces.values()) {
        if (surface.mesh !== hit.object || !hit.uv) continue;
        const x = THREE.MathUtils.clamp(Math.floor(hit.uv.x * surface.canvas.width), 0, surface.canvas.width - 1);
        const y = THREE.MathUtils.clamp(Math.floor((1 - hit.uv.y) * surface.canvas.height), 0, surface.canvas.height - 1);
        const pixel = surface.context.getImageData(x, y, 1, 1).data;
        if (pixel[3] === 0 && surface.transparentLayer) return avatar.baseColor;
        return rgbToHex(pixel[0]!, pixel[1]!, pixel[2]!);
      }
    }

    const material = getHitMaterial(hit.object, hit.faceIndex);
    const materialColor = (material as THREE.Material & { color?: THREE.Color } | undefined)?.color;
    // This is the authored material color, not a rendered screen pixel, so
    // lighting and shadows cannot make a picked coat darker or lighter.
    return materialColor ? `#${materialColor.getHexString(THREE.SRGBColorSpace)}` : undefined;
  }

  paintAtScreen(clientX: number, clientY: number, color: string, size: number): PaintStroke | undefined {
    return this.paintDabAtScreen(clientX, clientY, color, size);
  }

  paintBrushAtScreen(clientX: number, clientY: number, color: string, size: number): PaintStroke[] {
    return this.paintBrushLineAtScreen(clientX, clientY, clientX, clientY, color, size);
  }

  paintBrushLineAtScreen(
    fromX: number,
    fromY: number,
    clientX: number,
    clientY: number,
    color: string,
    size: number
  ): PaintStroke[] {
    const radius = 3 + size * 160;
    const avatar = this.avatars.get(this.selfId);
    const surface = avatar?.paintSurfaces.get("body");
    if (!avatar?.state.alive || avatar.state.role !== "hider" || !surface?.uvPaintLayer) {
      const stroke = this.paintDabAtScreen(clientX, clientY, color, size);
      return stroke ? [stroke] : [];
    }

    const geometry = surface.mesh.geometry;
    const positions = geometry.getAttribute("position");
    const uvs = geometry.getAttribute("uv");
    if (!positions || !uvs) return [];
    if (surface.mesh instanceof THREE.SkinnedMesh) surface.mesh.skeleton.update();
    surface.mesh.updateWorldMatrix(true, false);
    this.camera.updateMatrixWorld(true);
    const canvasBounds = this.canvas.getBoundingClientRect();
    const projected = new Float32Array(positions.count * 3);
    const vertex = new THREE.Vector3();
    for (let index = 0; index < positions.count; index += 1) {
      surface.mesh.getVertexPosition(index, vertex);
      surface.mesh.localToWorld(vertex);
      vertex.project(this.camera);
      projected[index * 3] = canvasBounds.left + (vertex.x + 1) * canvasBounds.width * 0.5;
      projected[index * 3 + 1] = canvasBounds.top + (1 - vertex.y) * canvasBounds.height * 0.5;
      projected[index * 3 + 2] = vertex.z;
    }

    // A tiny software depth buffer identifies exactly which model triangles
    // are visible beneath the swept circular cursor. Painting then happens once per
    // visible face, rather than expanding through neighboring model vertices.
    const segmentX = clientX - fromX;
    const segmentY = clientY - fromY;
    const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
    // Dabs use pixel-exact visibility to catch tiny faces. Longer swept lines
    // use a 2.5 px depth grid so one fast pointer move still finishes in-frame.
    const sampleStep = segmentLengthSquared > radius * radius * 0.25 ? 2.5 : 1;
    const sampleLeft = Math.min(fromX, clientX) - radius;
    const sampleTop = Math.min(fromY, clientY) - radius;
    const sampleColumns = Math.ceil((Math.abs(clientX - fromX) + radius * 2) / sampleStep);
    const sampleRows = Math.ceil((Math.abs(clientY - fromY) + radius * 2) / sampleStep);
    const depths = new Float32Array(sampleColumns * sampleRows);
    depths.fill(Number.POSITIVE_INFINITY);
    const visibleFaces = new Int32Array(sampleColumns * sampleRows);
    visibleFaces.fill(-1);
    const faceCount = geometry.index ? Math.floor(geometry.index.count / 3) : Math.floor(positions.count / 3);
    const radiusSquared = radius * radius;

    for (let face = 0; face < faceCount; face += 1) {
      const faceVertices = paintFaceVertices(geometry, face);
      const ax = projected[faceVertices[0] * 3]!;
      const ay = projected[faceVertices[0] * 3 + 1]!;
      const bx = projected[faceVertices[1] * 3]!;
      const by = projected[faceVertices[1] * 3 + 1]!;
      const cx = projected[faceVertices[2] * 3]!;
      const cy = projected[faceVertices[2] * 3 + 1]!;
      const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(denominator) < 1e-5) continue;
      const minColumn = Math.max(0, Math.floor((Math.min(ax, bx, cx) - sampleLeft) / sampleStep));
      const maxColumn = Math.min(sampleColumns - 1, Math.floor((Math.max(ax, bx, cx) - sampleLeft) / sampleStep));
      const minRow = Math.max(0, Math.floor((Math.min(ay, by, cy) - sampleTop) / sampleStep));
      const maxRow = Math.min(sampleRows - 1, Math.floor((Math.max(ay, by, cy) - sampleTop) / sampleStep));
      if (minColumn > maxColumn || minRow > maxRow) continue;
      const az = projected[faceVertices[0] * 3 + 2]!;
      const bz = projected[faceVertices[1] * 3 + 2]!;
      const cz = projected[faceVertices[2] * 3 + 2]!;
      for (let row = minRow; row <= maxRow; row += 1) {
        const y = sampleTop + (row + 0.5) * sampleStep;
        for (let column = minColumn; column <= maxColumn; column += 1) {
          const x = sampleLeft + (column + 0.5) * sampleStep;
          const along = segmentLengthSquared > 0
            ? THREE.MathUtils.clamp(((x - fromX) * segmentX + (y - fromY) * segmentY) / segmentLengthSquared, 0, 1)
            : 0;
          const offsetX = x - (fromX + segmentX * along);
          const offsetY = y - (fromY + segmentY * along);
          if (offsetX * offsetX + offsetY * offsetY > radiusSquared) continue;
          const first = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator;
          const second = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator;
          const third = 1 - first - second;
          if (first < -0.001 || second < -0.001 || third < -0.001) continue;
          const depth = first * az + second * bz + third * cz;
          const sample = row * sampleColumns + column;
          if (depth >= depths[sample]!) continue;
          depths[sample] = depth;
          visibleFaces[sample] = face;
        }
      }
    }

    const selectedFaces = new Set<number>();
    for (const face of visibleFaces) if (face >= 0) selectedFaces.add(face);
    const strokes: PaintStroke[] = [];
    for (const face of selectedFaces) {
      const faceVertices = paintFaceVertices(geometry, face);
      const ax = projected[faceVertices[0] * 3]!;
      const ay = projected[faceVertices[0] * 3 + 1]!;
      const bx = projected[faceVertices[1] * 3]!;
      const by = projected[faceVertices[1] * 3 + 1]!;
      const cx = projected[faceVertices[2] * 3]!;
      const cy = projected[faceVertices[2] * 3 + 1]!;
      const determinant = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(determinant) < 1e-5) continue;
      const au = uvs.getX(faceVertices[0]);
      const av = uvs.getY(faceVertices[0]);
      const du1 = uvs.getX(faceVertices[1]) - au;
      const dv1 = uvs.getY(faceVertices[1]) - av;
      const du2 = uvs.getX(faceVertices[2]) - au;
      const dv2 = uvs.getY(faceVertices[2]) - av;
      const duDx = (du1 * (cy - ay) - du2 * (by - ay)) / determinant;
      const duDy = (-du1 * (cx - ax) + du2 * (bx - ax)) / determinant;
      const dvDx = (dv1 * (cy - ay) - dv2 * (by - ay)) / determinant;
      const dvDy = (-dv1 * (cx - ax) + dv2 * (bx - ax)) / determinant;
      const startU = au + duDx * (fromX - ax) + duDy * (fromY - ay);
      const startV = av + dvDx * (fromX - ax) + dvDy * (fromY - ay);
      const stroke: PaintStroke = {
        part: "body",
        face,
        u: roundPaintValue(startU),
        v: roundPaintValue(startV),
        brushUx: roundPaintValue(duDx * radius),
        brushVx: roundPaintValue(dvDx * radius),
        brushUy: roundPaintValue(duDy * radius),
        brushVy: roundPaintValue(dvDy * radius),
        color,
        size
      };
      if (segmentLengthSquared > 0.01) {
        stroke.brushEndU = roundPaintValue(au + duDx * (clientX - ax) + duDy * (clientY - ay));
        stroke.brushEndV = roundPaintValue(av + dvDx * (clientX - ax) + dvDy * (clientY - ay));
      }
      this.applyPaintStroke(this.selfId, stroke);
      strokes.push(stroke);
    }
    return strokes;
  }

  private paintDabAtScreen(clientX: number, clientY: number, color: string, size: number): PaintStroke | undefined {
    const avatar = this.avatars.get(this.selfId);
    if (!avatar?.state.alive || avatar.state.role !== "hider") return undefined;
    this.setRayFromScreen(clientX, clientY);
    const meshes = [...avatar.paintSurfaces.values()].map((surface) => surface.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    const part = hit?.object.userData.paintPart as PaintPart | undefined;
    if (!hit?.uv || !part) return undefined;
    const stroke: PaintStroke = {
      part,
      u: roundPaintValue(hit.uv.x),
      v: roundPaintValue(hit.uv.y),
      face: hit.faceIndex ?? undefined,
      color,
      size
    };
    this.applyPaintStroke(this.selfId, stroke);
    return stroke;
  }

  applyPaintStroke(playerId: string, stroke: PaintStroke): void {
    const avatar = this.avatars.get(playerId);
    if (!avatar) {
      const pending = this.pendingPaint.get(playerId) ?? [];
      pending.push(stroke);
      this.pendingPaint.set(playerId, pending);
      return;
    }
    avatar.strokes.push(stroke);
    this.drawStroke(avatar, stroke);
  }

  removePaintAction(playerId: string, actionId: string): void {
    const avatar = this.avatars.get(playerId);
    if (!avatar) {
      const pending = this.pendingPaint.get(playerId);
      if (pending) removeLatestPaintAction(pending, actionId);
      return;
    }
    removeLatestPaintAction(avatar.strokes, actionId);
    this.redrawPaint(avatar);
  }

  applyPaintState(players: PlayerPaintState[]): void {
    for (const player of players) {
      const avatar = this.avatars.get(player.playerId);
      if (!avatar) {
        this.pendingPaint.set(player.playerId, [...player.strokes]);
        continue;
      }
      avatar.strokes = [...player.strokes];
      this.redrawPaint(avatar);
    }
  }

  resetPaint(playerId?: string): void {
    if (playerId) {
      this.pendingPaint.delete(playerId);
      const avatar = this.avatars.get(playerId);
      if (avatar) {
        avatar.strokes = [];
        this.redrawPaint(avatar);
      }
      return;
    }
    this.pendingPaint.clear();
    for (const avatar of this.avatars.values()) {
      avatar.strokes = [];
      this.redrawPaint(avatar);
    }
  }

  flashShot(): void {
    const self = this.avatars.get(this.selfId);
    if (!self) return;
    this.showMuzzleFlash(self);
  }

  showShot(hunterId: string, origin: { x: number; y: number; z: number }, end: { x: number; y: number; z: number }): void {
    const hunter = this.avatars.get(hunterId);
    const start = hunter?.muzzle.getWorldPosition(new THREE.Vector3())
      ?? new THREE.Vector3(origin.x, origin.y, origin.z);
    const finish = new THREE.Vector3(end.x, end.y, end.z);
    const tracer = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([start, finish]),
      new THREE.LineBasicMaterial({ color: "#ffd36a", transparent: true, opacity: 0.92 })
    );
    tracer.renderOrder = 20;
    this.scene.add(tracer);
    if (hunter) this.showMuzzleFlash(hunter);
    window.setTimeout(() => {
      this.scene.remove(tracer);
      tracer.geometry.dispose();
      (tracer.material as THREE.Material).dispose();
    }, 105);
  }

  destroy(): void {
    this.running = false;
    this.collisionDebugFillMaterial.dispose();
    this.collisionDebugLineMaterial.dispose();
    this.renderer.dispose();
  }

  private buildLighting(): void {
    this.scene.add(new THREE.HemisphereLight("#f7f0d7", "#53616c", 2.4));
    const sun = new THREE.DirectionalLight("#fff5d6", 4.2);
    sun.position.set(-13, 22, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -28;
    sun.shadow.camera.right = 28;
    sun.shadow.camera.top = 28;
    sun.shadow.camera.bottom = -28;
    sun.shadow.bias = -0.0002;
    this.scene.add(sun);

    const orange = new THREE.PointLight("#ff8b5b", 18, 18, 2);
    orange.position.set(-14, 5, -12);
    this.scene.add(orange);
    const cyan = new THREE.PointLight("#5edbd1", 16, 17, 2);
    cyan.position.set(13, 4, 10);
    this.scene.add(cyan);
  }

  private buildWorld(): void {
    if (WORLD_FLOOR_VISIBLE) {
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE),
        new THREE.MeshStandardMaterial({ color: WORLD_FLOOR_COLOR, roughness: 0.92, metalness: 0 })
      );
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      floor.userData.sampleColor = WORLD_FLOOR_COLOR;
      this.sampleSurfaces.push(floor);
      this.scene.add(floor);

      const grid = new THREE.GridHelper(WORLD_SIZE, Math.max(8, Math.round(WORLD_SIZE)), "#8f846f", "#a99d83");
      grid.position.y = 0.008;
      const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
      for (const material of materials) {
        material.opacity = 0.22;
        material.transparent = true;
      }
      this.scene.add(grid);
    }

    for (const box of WORLD_BOXES) {
      const geometry = new THREE.BoxGeometry(...box.size);
      const material = new THREE.MeshStandardMaterial({ color: box.color, roughness: box.kind === "column" ? 0.45 : 0.78 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...box.position);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.sampleColor = box.color;
      this.sampleSurfaces.push(mesh);
      this.scene.add(mesh);
      if (box.solid) this.addCollisionDebugShape(geometry, mesh.position);
      this.addBoxDetails(mesh, box.kind);
    }

    for (const hull of WORLD_HULLS) {
      if (hull.vertices.length < 4) continue;
      const geometry = hull.triangles?.length
        ? new THREE.BufferGeometry()
        : new ConvexGeometry(hull.vertices.map((vertex) => new THREE.Vector3(...vertex)));
      if (hull.triangles?.length) {
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(hull.vertices.flat(), 3));
        geometry.setIndex(hull.triangles.flat());
        geometry.computeVertexNormals();
      }
      const hasGeneratedDebugCollision = hull.modelId !== undefined
        && WORLD_MODELS.some((model) => model.id === hull.modelId && model.collisionUrl);
      if (hull.solid && !hasGeneratedDebugCollision) this.addCollisionDebugShape(geometry);
      if (hull.visible === false) continue;
      const material = new THREE.MeshStandardMaterial({ color: hull.color, roughness: 0.7 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.sampleColor = hull.color;
      this.sampleSurfaces.push(mesh);
      this.scene.add(mesh);
      mesh.add(new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 18),
        new THREE.LineBasicMaterial({ color: "#273138", transparent: true, opacity: 0.22 })
      ));
    }

    void this.loadWorldModels();
  }

  private addCollisionDebugShape(geometry: THREE.BufferGeometry, position?: THREE.Vector3): void {
    const debugMesh = new THREE.Mesh(geometry, this.collisionDebugFillMaterial);
    if (position) debugMesh.position.copy(position);
    debugMesh.renderOrder = 100;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 12), this.collisionDebugLineMaterial);
    edges.renderOrder = 101;
    debugMesh.add(edges);
    this.collisionDebugRoot.add(debugMesh);
  }

  private async loadWorldModels(): Promise<void> {
    for (const worldModel of WORLD_MODELS) {
      try {
        const gltf = await new GLTFLoader().loadAsync(worldModel.url);
      const root = new THREE.Group();
      const visual = gltf.scene;
      root.add(visual);
      root.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(root);
      if (bounds.isEmpty()) throw new Error("The map model contains no visible geometry.");
      const visualCenter = bounds.getCenter(new THREE.Vector3());
      visual.position.sub(visualCenter);
        root.position.set(...worldModel.position);
        root.rotation.set(...worldModel.rotation);
        root.scale.set(...worldModel.scale);
        root.updateMatrixWorld(true);
        let meshCount = 0;
        root.traverse((child) => {
          if (child instanceof THREE.Mesh) meshCount += 1;
        });
        // Complete environment GLBs can contain hundreds of separately named
        // meshes. Rendering all of them into the shadow map doubles their draw
        // work, so large static scenes receive lighting without casting shadows.
        const castModelShadows = meshCount <= 250;
        root.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          child.castShadow = castModelShadows;
          child.receiveShadow = true;
        const material = Array.isArray(child.material) ? child.material[0] : child.material;
        if (material && "color" in material && material.color instanceof THREE.Color) {
          child.userData.sampleColor = `#${material.color.getHexString()}`;
        }
        this.sampleSurfaces.push(child);
        });
        this.scene.add(root);
        this.collisionDebugModelCenters.set(worldModel.id, visualCenter);
        if (this.collisionDebugRoot.visible) void this.loadModelCollisionDebug(worldModel, visualCenter);
      } catch (error) {
        console.warn(`The active map model ${worldModel.id} failed to load.`, error);
      }
    }
  }

  private async loadModelCollisionDebug(worldModel: (typeof WORLD_MODELS)[number], visualCenter: THREE.Vector3): Promise<void> {
    if (!worldModel.collisionUrl
        || this.collisionDebugModelsLoading.has(worldModel.id)
        || this.collisionDebugModelsLoaded.has(worldModel.id)) return;
    this.collisionDebugModelsLoading.add(worldModel.id);
    try {
      const gltf = await new GLTFLoader().loadAsync(worldModel.collisionUrl);
      const root = new THREE.Group();
      const collision = gltf.scene;
      collision.position.sub(visualCenter);
      let replacedCenterDoorPanel = false;
      collision.traverse((child) => {
        if (!(child instanceof THREE.Mesh)
            || !child.name.toLowerCase().includes("wall_020_part_0055")) return;
        child.visible = false;
        replacedCenterDoorPanel = true;
      });
      if (replacedCenterDoorPanel) {
        const rotation = new THREE.Quaternion(0, -0.7071065, 0, 0.707107);
        for (const [name, size, position] of [
          ["center-door-wall-side", [0.12, 8, 4], [-4.128819, 4.000001, -11.85918]],
          ["center-door-wall-lintel", [0.12, 4, 4], [-0.128819, 6.000001, -11.85918]]
        ] as const) {
          const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(size[0], size[1], size[2]),
            this.collisionDebugFillMaterial
          );
          mesh.name = name;
          mesh.position.set(position[0], position[1], position[2]);
          mesh.quaternion.copy(rotation);
          collision.add(mesh);
        }
      }
      root.add(collision);
      root.position.set(...worldModel.position);
      root.rotation.set(...worldModel.rotation);
      root.scale.set(...worldModel.scale);
      root.updateMatrixWorld(true);
      root.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.material = this.collisionDebugFillMaterial;
        child.renderOrder = 100;
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(child.geometry, 12),
          this.collisionDebugLineMaterial
        );
        edges.renderOrder = 101;
        child.add(edges);
      });
      this.collisionDebugRoot.add(root);
      this.collisionDebugModelsLoaded.add(worldModel.id);
    } catch (error) {
      console.warn(`The collision debug model for ${worldModel.id} failed to load.`, error);
    } finally {
      this.collisionDebugModelsLoading.delete(worldModel.id);
    }
  }

  private addBoxDetails(mesh: THREE.Mesh, kind: string): void {
    if (kind === "crate") {
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry),
        new THREE.LineBasicMaterial({ color: "#273138", transparent: true, opacity: 0.24 })
      );
      mesh.add(edges);
    }
    if (kind === "planter") {
      const leafMaterial = new THREE.MeshStandardMaterial({ color: "#2f6551", roughness: 0.8 });
      for (let index = 0; index < 7; index += 1) {
        const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.58 + (index % 3) * 0.12, 12, 8), leafMaterial);
        leaf.scale.y = 1.45;
        leaf.position.set(-2.3 + index * 0.75, 1.1 + (index % 2) * 0.25, (index % 3 - 1) * 0.42);
        leaf.castShadow = true;
        mesh.add(leaf);
      }
    }
  }

  private addFactoryDetails(): void {
    const pipeMaterial = new THREE.MeshStandardMaterial({ color: "#334b54", metalness: 0.55, roughness: 0.3 });
    for (const x of [-8, 0, 8]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 42, 10), pipeMaterial);
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(x, 5.4, 0);
      pipe.castShadow = true;
      this.scene.add(pipe);
    }

    const bannerColors = ["#d9564a", "#e7b844", "#4a9d91", "#8067a8", "#d97843"];
    for (let index = 0; index < 9; index += 1) {
      const color = bannerColors[index % bannerColors.length] ?? "#ffffff";
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.9), new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.9 }));
      banner.position.set(-15 + index * 3.75, 4.55, -19.9);
      banner.userData.sampleColor = color;
      this.sampleSurfaces.push(banner);
      this.scene.add(banner);
    }

    const siloMaterial = new THREE.MeshStandardMaterial({ color: "#70858c", metalness: 0.35, roughness: 0.5 });
    for (const [x, z] of [[-18, -6], [18, 5]] as const) {
      const silo = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 4, 18), siloMaterial);
      silo.position.set(x, 2, z);
      silo.castShadow = true;
      this.scene.add(silo);
    }
  }

  private async loadCharacterModel(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync("/models/chameleon-man-pro.glb?v=4");
      this.characterTemplate = gltf.scene;
      this.characterAnimations = [...gltf.animations, ...createHunterCarryClips(gltf.animations)];
      this.characterAlignment = this.measureStandingCharacterAlignment();

      for (const [id, oldAvatar] of [...this.avatars]) {
        if (!oldAvatar.procedural) continue;
        const replacement = this.createModelAvatar(oldAvatar.state);
        replacement.root.position.copy(oldAvatar.root.position);
        replacement.root.rotation.copy(oldAvatar.root.rotation);
        replacement.root.visible = oldAvatar.root.visible;
        replacement.serverPosition.copy(oldAvatar.serverPosition);
        replacement.target.copy(oldAvatar.target);
        replacement.targetYaw = oldAvatar.targetYaw;
        replacement.strokes = [...oldAvatar.strokes];
        this.redrawPaint(replacement);
        this.scene.remove(oldAvatar.root);
        this.scene.add(replacement.root);
        this.avatars.set(id, replacement);
      }
    } catch (error) {
      console.warn("Chameleon Man Pro failed to load; using the procedural fallback.", error);
    }
  }

  private async loadShotgunModel(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync("/models/meccha-chameleon-shotgun.glb");
      this.shotgunTemplate = gltf.scene;
      for (const avatar of this.avatars.values()) this.replaceShotgun(avatar);
    } catch (error) {
      console.warn("Meccha Chameleon shotgun failed to load; using the procedural fallback.", error);
    }
  }

  private replaceShotgun(avatar: Avatar): void {
    if (!this.shotgunTemplate) return;
    const previous = avatar.weapon;
    const { weapon, muzzle } = createShotgun(this.shotgunTemplate);
    weapon.position.copy(previous.position);
    weapon.rotation.copy(previous.rotation);
    weapon.visible = previous.visible;
    avatar.root.remove(previous);
    avatar.root.add(weapon);
    avatar.weapon = weapon;
    avatar.muzzle = muzzle;
    avatar.weaponBasePosition.copy(weapon.position);
    disposeObject(previous);
  }

  private createAvatar(state: PlayerState): Avatar {
    return this.characterTemplate ? this.createModelAvatar(state) : this.createProceduralAvatar(state);
  }

  private measureStandingCharacterAlignment(): CharacterAlignment {
    if (!this.characterTemplate) return { scale: 1, position: new THREE.Vector3() };
    const reference = cloneSkeleton(this.characterTemplate);
    reference.rotation.y = Math.PI;
    const standingClip = this.characterAnimations.find((clip) => clip.name === POSE_CLIPS.stand);
    let mixer: THREE.AnimationMixer | undefined;
    if (standingClip) {
      mixer = new THREE.AnimationMixer(reference);
      mixer.clipAction(standingClip).reset().play();
      mixer.update(0);
    }
    reference.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(reference, true);
    mixer?.stopAllAction();
    mixer?.uncacheRoot(reference);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const scale = size.y > 0 ? CHARACTER_HEIGHT / size.y : 1;
    return {
      scale,
      position: new THREE.Vector3(-center.x * scale, -bounds.min.y * scale, -center.z * scale)
    };
  }

  private createModelAvatar(state: PlayerState): Avatar {
    if (!this.characterTemplate) return this.createProceduralAvatar(state);
    const root = new THREE.Group();
    const visual = cloneSkeleton(this.characterTemplate);
    visual.rotation.y = Math.PI;
    const alignment = this.characterAlignment ?? this.measureStandingCharacterAlignment();
    visual.scale.setScalar(alignment.scale);
    visual.position.copy(alignment.position);
    root.add(visual);

    const canvas = document.createElement("canvas");
    canvas.width = PAINT_TEXTURE_SIZE;
    canvas.height = PAINT_TEXTURE_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D painting is unavailable");
    context.clearRect(0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const material = createPaintLayerMaterial(state.color, texture);
    const paintSurfaces = new Map<PaintPart, PaintSurface>();
    let characterMesh: THREE.Mesh | undefined;
    const bodyPitchBones: Array<{ bone: THREE.Object3D; weight: number }> = [];
    const locomotionArmBones: Partial<Record<LocomotionArmBoneName, THREE.Object3D>> = {};
    let rightUpperArmBone: THREE.Object3D | undefined;
    let rightLowerArmBone: THREE.Object3D | undefined;
    let rightHandBone: THREE.Object3D | undefined;
    visual.traverse((child) => {
      const normalizedName = child.name.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (normalizedName === "upperarmr") rightUpperArmBone = child;
      if (normalizedName === "lowerarmr") rightLowerArmBone = child;
      if (normalizedName === "handr") rightHandBone = child;
      const pitchWeight = BODY_PITCH_BONES.get(normalizedName);
      if (pitchWeight !== undefined) bodyPitchBones.push({ bone: child, weight: pitchWeight });
      if (LOCOMOTION_ARM_POSE.has(child.name as LocomotionArmBoneName)) locomotionArmBones[child.name as LocomotionArmBoneName] = child;
      if (!(child instanceof THREE.Mesh)) return;
      child.material = material;
      child.castShadow = true;
      child.receiveShadow = true;
      child.userData.paintPart = "body" satisfies PaintPart;
      characterMesh ??= child;
    });
    if (!characterMesh) throw new Error("Chameleon Man Pro does not contain a mesh");
    paintSurfaces.set("body", {
      mesh: characterMesh,
      canvas,
      context,
      texture,
      material,
      uvPaintLayer: true,
      transparentLayer: true
    });

    const hunterMark = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.055, 8, 24), new THREE.MeshBasicMaterial({ color: "#ff594f" }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 2.68;
    hunterMark.add(ring);
    root.add(hunterMark);

    const { weapon, muzzle } = createShotgun(this.shotgunTemplate);
    weapon.position.set(0.38, 1.42, -0.62);
    weapon.rotation.set(0, 0, 0);
    weapon.visible = state.role === "hunter" && state.alive;
    root.add(weapon);

    const whistleRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.75, 0.035, 6, 30),
      new THREE.MeshBasicMaterial({ color: "#fff2a8", transparent: true, opacity: 0.85 })
    );
    whistleRing.rotation.x = Math.PI / 2;
    whistleRing.position.y = 1.25;
    whistleRing.visible = false;
    root.add(whistleRing);

    const mixer = new THREE.AnimationMixer(visual);
    const actions = new Map(this.characterAnimations.map((clip) => [clip.name, mixer.clipAction(clip)]));
    const avatar: Avatar = {
      root,
      serverPosition: root.position.clone(),
      target: root.position.clone(),
      snapshotReceivedAt: performance.now(),
      targetYaw: state.yaw,
      baseColor: state.color,
      paintSurfaces,
      strokes: this.pendingPaint.get(state.id) ?? [],
      procedural: false,
      visual,
      visualBasePosition: alignment.position.clone(),
      bodyPitch: 0,
      bodyPitchApplied: 0,
      bodyPitchBones,
      locomotionArmBones,
      rightUpperArmBone,
      rightLowerArmBone,
      rightHandBone,
      mixer,
      actions,
      hunterMark,
      weapon,
      muzzle,
      weaponBasePosition: weapon.position.clone(),
      recoilUntil: 0,
      whistleRing,
      state
    };
    this.pendingPaint.delete(state.id);
    this.redrawPaint(avatar);
    return avatar;
  }

  private createProceduralAvatar(state: PlayerState): Avatar {
    const root = new THREE.Group();
    const visual = new THREE.Group();
    root.add(visual);
    const paintSurfaces = new Map<PaintPart, PaintSurface>();
    const makePaintedMesh = (part: PaintPart, geometry: THREE.BufferGeometry): THREE.Mesh => {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D painting is unavailable");
      context.fillStyle = state.color;
      context.fillRect(0, 0, canvas.width, canvas.height);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.paintPart = part;
      paintSurfaces.set(part, { mesh, canvas, context, texture, material });
      return mesh;
    };
    const dark = new THREE.MeshStandardMaterial({ color: "#1a252b", roughness: 0.55 });
    const body = makePaintedMesh("body", new THREE.CapsuleGeometry(0.5, 0.62, 6, 12));
    body.position.y = 1.1;
    const head = makePaintedMesh("head", new THREE.SphereGeometry(0.48, 20, 16));
    head.position.y = 2.05;
    const leftArm = makePaintedMesh("leftArm", new THREE.CapsuleGeometry(0.19, 0.75, 4, 10));
    leftArm.position.set(-0.63, 1.15, 0);
    const rightArm = makePaintedMesh("rightArm", new THREE.CapsuleGeometry(0.19, 0.75, 4, 10));
    rightArm.position.set(0.63, 1.15, 0);
    const leftLeg = makePaintedMesh("leftLeg", new THREE.CapsuleGeometry(0.21, 0.72, 4, 10));
    leftLeg.position.set(-0.27, 0.42, 0);
    const rightLeg = makePaintedMesh("rightLeg", new THREE.CapsuleGeometry(0.21, 0.72, 4, 10));
    rightLeg.position.set(0.27, 0.42, 0);
    visual.add(body, head, leftArm, rightArm, leftLeg, rightLeg);

    for (const x of [-0.17, 0.17]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), dark);
      eye.position.set(x, 2.12, -0.45);
      visual.add(eye);
    }

    const hunterMark = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.055, 8, 24), new THREE.MeshBasicMaterial({ color: "#ff594f" }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 2.55;
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.48, 6), dark);
    antenna.position.y = 2.66;
    hunterMark.add(ring, antenna);
    root.add(hunterMark);

    const { weapon, muzzle } = createShotgun(this.shotgunTemplate);
    weapon.position.set(0.38, 1.42, -0.62);
    weapon.rotation.set(0, 0, 0);
    weapon.visible = state.role === "hunter" && state.alive;
    root.add(weapon);

    const whistleRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.75, 0.035, 6, 30),
      new THREE.MeshBasicMaterial({ color: "#fff2a8", transparent: true, opacity: 0.85 })
    );
    whistleRing.rotation.x = Math.PI / 2;
    whistleRing.position.y = 1.25;
    whistleRing.visible = false;
    root.add(whistleRing);

    root.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    const avatar: Avatar = {
      root,
      serverPosition: root.position.clone(),
      target: root.position.clone(),
      snapshotReceivedAt: performance.now(),
      targetYaw: state.yaw,
      baseColor: state.color,
      paintSurfaces,
      strokes: this.pendingPaint.get(state.id) ?? [],
      procedural: true,
      visual,
      visualBasePosition: new THREE.Vector3(),
      body,
      head,
      leftArm,
      rightArm,
      leftLeg,
      rightLeg,
      bodyPitch: 0,
      bodyPitchApplied: 0,
      hunterMark,
      weapon,
      muzzle,
      weaponBasePosition: weapon.position.clone(),
      recoilUntil: 0,
      whistleRing,
      state
    };
    this.pendingPaint.delete(state.id);
    this.redrawPaint(avatar);
    return avatar;
  }

  private setRayFromScreen(clientX: number, clientY: number): void {
    const bounds = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((clientX - bounds.left) / bounds.width) * 2 - 1,
      -((clientY - bounds.top) / bounds.height) * 2 + 1
    );
    this.raycaster.setFromCamera(pointer, this.camera);
  }

  private redrawPaint(avatar: Avatar): void {
    for (const surface of avatar.paintSurfaces.values()) {
      if (surface.transparentLayer) {
        surface.context.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
        surface.material.color.set(avatar.baseColor);
      } else {
        surface.context.fillStyle = avatar.baseColor;
        surface.context.fillRect(0, 0, surface.canvas.width, surface.canvas.height);
      }
      surface.texture.needsUpdate = true;
    }
    for (const stroke of avatar.strokes) this.drawStroke(avatar, stroke);
  }

  private drawStroke(avatar: Avatar, stroke: PaintStroke): void {
    const surface = avatar.paintSurfaces.get(stroke.part) ?? avatar.paintSurfaces.get("body");
    if (!surface) return;
    if (surface.uvPaintLayer) {
      if (!drawProjectedFaceStroke(surface, stroke)) drawUvPaintDot(surface, stroke);
      surface.texture.needsUpdate = true;
      return;
    }
    const x = stroke.u * surface.canvas.width;
    const y = (1 - stroke.v) * surface.canvas.height;
    const radius = Math.max(2, stroke.size * surface.canvas.width);
    surface.context.fillStyle = stroke.color;
    for (const wrapOffset of [-surface.canvas.width, 0, surface.canvas.width]) {
      surface.context.beginPath();
      surface.context.arc(x + wrapOffset, y, radius, 0, Math.PI * 2);
      surface.context.fill();
    }
    surface.texture.needsUpdate = true;
  }

  private showMuzzleFlash(avatar: Avatar): void {
    const now = performance.now();
    avatar.recoilUntil = now + 140;
    const position = avatar.muzzle.getWorldPosition(new THREE.Vector3());
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 8, 6),
      new THREE.MeshBasicMaterial({ color: "#fff0a4", transparent: true, opacity: 0.95 })
    );
    flash.position.copy(position);
    const light = new THREE.PointLight("#ff9d45", 18, 8, 2);
    light.position.copy(position);
    this.scene.add(flash, light);
    window.setTimeout(() => {
      this.scene.remove(flash, light);
      flash.geometry.dispose();
      (flash.material as THREE.Material).dispose();
    }, 72);
  }

  private setAvatarAnimation(avatar: Avatar, name: string, looping: boolean, timeScale = 1): void {
    if (avatar.procedural || avatar.activeAnimation === name) {
      avatar.activeAction?.setEffectiveTimeScale(timeScale);
      return;
    }
    const next = avatar.actions?.get(name);
    if (!next) return;

    avatar.activeAction?.fadeOut(0.12);
    next.reset();
    next.enabled = true;
    next.clampWhenFinished = !looping;
    next.setLoop(looping ? THREE.LoopRepeat : THREE.LoopOnce, looping ? Infinity : 1);
    next.setEffectiveWeight(1);
    next.setEffectiveTimeScale(timeScale);
    next.fadeIn(0.12).play();
    if (!looping) next.paused = true;
    avatar.activeAction = next;
    avatar.activeAnimation = name;
    avatar.mixer?.update(0);
  }

  private setPose(avatar: Avatar, pose: PlayerState["pose"]): void {
    if (!avatar.procedural) return;
    const { body, head, leftArm, rightArm, leftLeg, rightLeg } = avatar;
    if (!body || !head || !leftArm || !rightArm || !leftLeg || !rightLeg) return;
    const compact = COMPACT_POSES.has(pose);
    const curled = pose === "fetal" || pose === "crouchedFetal" || pose === "curledUp";
    body.scale.set(curled ? 1.35 : 1, curled ? 0.62 : compact ? 0.76 : 1, curled ? 1.35 : 1);
    body.position.y = curled ? 0.56 : compact ? 0.86 : 1.1;
    head.position.y = curled ? 0.77 : compact ? 1.5 : 2.05;
    head.scale.setScalar(curled ? 0.72 : 1);
    leftArm.visible = !curled;
    rightArm.visible = !curled;
    leftLeg.visible = !curled;
    rightLeg.visible = !curled;
    leftLeg.position.y = compact ? 0.25 : 0.42;
    rightLeg.position.y = compact ? 0.25 : 0.42;
    avatar.hunterMark.position.y = compact ? -0.4 : curled ? -1.1 : 0;
  }

  private applyAvatarBodyPitch(avatar: Avatar): void {
    const pitch = avatar.bodyPitch ?? 0;
    if (!avatar.procedural) {
      if (avatar.visual) avatar.visual.rotation.x = 0;
      for (const entry of avatar.bodyPitchBones ?? []) entry.bone.rotation.x += pitch * entry.weight;
      avatar.bodyPitchApplied = pitch;
      return;
    }
    if (!avatar.body || !avatar.head) return;
    avatar.body.rotation.x = pitch * 0.62;
    avatar.head.rotation.x = pitch * 0.38;
    avatar.bodyPitchApplied = pitch;
  }

  private updateAttachedVisualOffset(avatar: Avatar, dt: number): void {
    if (!avatar.visual || !avatar.visualBasePosition) return;
    this.attachedVisualTarget.copy(avatar.visualBasePosition);
    const cling = avatar.state.cling;
    if (cling) {
      const normalLength = Math.hypot(cling.normalX, cling.normalZ);
      if (normalLength > Number.EPSILON) {
        this.attachedVisualOffset.set(
          -cling.normalX / normalLength * CLING_VISUAL_INSET,
          0,
          -cling.normalZ / normalLength * CLING_VISUAL_INSET
        );
        this.attachedVisualOffset.applyAxisAngle(WORLD_UP, -avatar.root.rotation.y);
        this.attachedVisualTarget.add(this.attachedVisualOffset);
      }
    }
    avatar.visual.position.lerp(
      this.attachedVisualTarget,
      1 - Math.exp(-CLING_VISUAL_RESPONSE * dt)
    );
  }

  private clearAvatarBodyPitch(avatar: Avatar): void {
    const applied = avatar.bodyPitchApplied ?? 0;
    if (applied === 0) return;
    if (!avatar.procedural) {
      for (const entry of avatar.bodyPitchBones ?? []) entry.bone.rotation.x -= applied * entry.weight;
    }
    avatar.bodyPitchApplied = 0;
  }

  private localAvatarYaw(): number {
    if (!this.input) return 0;
    if (this.avatars.get(this.selfId)?.state.role === "hunter") return this.input.yaw;
    const { forward, strafe } = this.input.movement();
    if (Math.abs(forward) > 0.05 || Math.abs(strafe) > 0.05) return this.input.yaw - Math.atan2(strafe, forward);
    return this.input.yaw;
  }

  private remoteAvatarYaw(avatar: Avatar): number {
    if (avatar.state.role === "hunter") return avatar.targetYaw;
    const planarSpeed = Math.hypot(avatar.state.velocity.x, avatar.state.velocity.z);
    if (avatar.state.cling === undefined && planarSpeed > 0.3) {
      return Math.atan2(-avatar.state.velocity.x, -avatar.state.velocity.z);
    }
    return avatar.targetYaw;
  }

  private applyLocomotionArmPose(avatar: Avatar, running: boolean, displayPose: PlayerState["pose"], straightSprint: boolean): void {
    if (avatar.procedural || avatar.state.role === "hunter" || !running || !straightSprint || displayPose !== "stand") return;
    for (const [name, target] of LOCOMOTION_ARM_POSE) {
      const bone = avatar.locomotionArmBones?.[name];
      if (!bone) continue;
      bone.rotation.x = THREE.MathUtils.lerp(bone.rotation.x, target.x, LOCOMOTION_ARM_POSE_BLEND);
      bone.rotation.y = THREE.MathUtils.lerp(bone.rotation.y, target.y, LOCOMOTION_ARM_POSE_BLEND);
      bone.rotation.z = THREE.MathUtils.lerp(bone.rotation.z, target.z, LOCOMOTION_ARM_POSE_BLEND);
    }
  }

  private applyHunterPointingArm(avatar: Avatar): void {
    if (avatar.state.role !== "hunter" || avatar.procedural) return;
    const upperArm = avatar.rightUpperArmBone;
    const lowerArm = avatar.rightLowerArmBone;
    const hand = avatar.rightHandBone;
    if (!upperArm || !lowerArm || !hand) return;

    const pitch = this.hunterAimPitch(avatar);
    const relativeYaw = shortestAngle(avatar.root.rotation.y, this.hunterAimYaw(avatar));
    avatar.root.getWorldQuaternion(this.hunterArmQuaternion);
    this.hunterArmDirection
      .set(-Math.sin(relativeYaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(relativeYaw) * Math.cos(pitch))
      .applyQuaternion(this.hunterArmQuaternion)
      .normalize();
    this.pointBoneAtWorldDirection(upperArm, lowerArm, this.hunterArmDirection);
    this.pointBoneAtWorldDirection(lowerArm, hand, this.hunterArmDirection);
  }

  private pointBoneAtWorldDirection(bone: THREE.Object3D, child: THREE.Object3D, worldDirection: THREE.Vector3): void {
    if (!bone.parent || child.position.lengthSq() <= Number.EPSILON) return;
    bone.parent.getWorldQuaternion(this.hunterArmQuaternion).invert();
    this.hunterArmLocalDirection.copy(worldDirection).applyQuaternion(this.hunterArmQuaternion).normalize();
    this.hunterArmRestDirection.copy(child.position).normalize();
    bone.quaternion.setFromUnitVectors(this.hunterArmRestDirection, this.hunterArmLocalDirection);
    bone.updateWorldMatrix(true, true);
  }

  private updateHunterWeaponTransform(avatar: Avatar, recoilRemaining: number): void {
    if (avatar.state.role !== "hunter") return;
    const pitch = this.hunterAimPitch(avatar);
    const relativeYaw = shortestAngle(avatar.root.rotation.y, this.hunterAimYaw(avatar));
    avatar.weapon.rotation.order = "YXZ";
    avatar.weapon.rotation.set(pitch, relativeYaw, 0);
    if (!avatar.procedural && avatar.rightHandBone) {
      avatar.root.updateWorldMatrix(true, true);
      avatar.rightHandBone.getWorldPosition(this.hunterHandPosition);
      avatar.root.worldToLocal(this.hunterHandPosition);
    } else {
      this.hunterHandPosition.set(0.48, 1.42, -1.02);
    }
    this.hunterWeaponGripOffset
      .copy(HUNTER_WEAPON_GRIP_POSITION)
      .applyQuaternion(avatar.weapon.quaternion);
    avatar.weapon.position.copy(this.hunterHandPosition).sub(this.hunterWeaponGripOffset);
    this.hunterWeaponFineOffset
      .copy(HUNTER_WEAPON_FINE_OFFSET)
      .applyQuaternion(avatar.weapon.quaternion);
    avatar.weapon.position.add(this.hunterWeaponFineOffset);
    avatar.weaponBasePosition.copy(avatar.weapon.position);
    if (recoilRemaining > 0) {
      avatar.weapon.translateZ(Math.sin((recoilRemaining / 140) * Math.PI) * 0.13);
    }
  }

  private hunterAimPitch(avatar: Avatar): number {
    if (avatar.state.id === this.selfId && this.input) {
      return THREE.MathUtils.clamp(this.input.aim().pitch + HUNTER_NEUTRAL_INPUT_PITCH, -0.75, 0.45);
    }
    return hunterAimRadians(avatar.state);
  }

  private hunterAimYaw(avatar: Avatar): number {
    if (avatar.state.id === this.selfId && this.input) return this.input.aim().yaw;
    return hunterAimYaw(avatar.state);
  }

  private animate = (): void => {
    if (!this.running) return;
    requestAnimationFrame(this.animate);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.elapsedTime;

    const renderTime = performance.now();
    const selfAvatar = this.avatars.get(this.selfId);
    this.firstPersonHunterActive = Boolean(
      selfAvatar?.state.alive
      && selfAvatar.state.role === "hunter"
      && !this.paintView
    );
    for (const [id, avatar] of this.avatars) {
      avatar.root.visible = avatar.state.alive;
      // Keep the render target moving between network packets instead of easing
      // toward a stationary snapshot and producing a start/stop cadence.
      const extrapolation = Math.min((renderTime - avatar.snapshotReceivedAt) / 1_000, 0.1);
      avatar.target.set(
        avatar.serverPosition.x + avatar.state.velocity.x * extrapolation,
        Math.max(0, avatar.serverPosition.y + avatar.state.velocity.y * extrapolation),
        avatar.serverPosition.z + avatar.state.velocity.z * extrapolation
      );
      const positionResponse = 1 - Math.exp(-(id === this.selfId ? 26 : 16) * dt);
      avatar.root.position.lerp(avatar.target, positionResponse);

      const desiredYaw = id === this.selfId && this.input
        ? this.localAvatarYaw()
        : this.remoteAvatarYaw(avatar);
      const yawResponse = 1 - Math.exp(-(id === this.selfId ? LOCAL_TURN_RESPONSE : REMOTE_TURN_RESPONSE) * dt);
      avatar.root.rotation.y += shortestAngle(avatar.root.rotation.y, desiredYaw) * yawResponse;
      this.updateAttachedVisualOffset(avatar, dt);
      this.clearAvatarBodyPitch(avatar);
      const planarSpeed = Math.hypot(avatar.state.velocity.x, avatar.state.velocity.z);
      const displayPose = avatar.state.pose;
      const moving = avatar.state.cling === undefined && planarSpeed > 0.3;
      const canBodyPitch = id === this.selfId
        && avatar.state.cling === undefined
        && displayPose === "stand"
        && !this.firstPersonHunterActive
        && this.roundPhase === "waiting";
      const aimPitch = this.input ? this.input.aim().pitch : 0;
      const remoteHunterPitch = id !== this.selfId
        && avatar.state.role === "hunter"
        && avatar.state.cling === undefined
        && displayPose === "stand"
        ? THREE.MathUtils.clamp(hunterAimRadians(avatar.state) * HUNTER_BODY_PITCH_STRENGTH, -0.78, 0.58)
        : undefined;
      const targetBodyPitch = remoteHunterPitch
        ?? (canBodyPitch ? THREE.MathUtils.clamp(aimPitch * BODY_PITCH_STRENGTH, -MAX_BODY_PITCH_UP, MAX_BODY_PITCH_DOWN) : 0);
      avatar.bodyPitch = this.firstPersonHunterActive && id === this.selfId
        ? 0
        : THREE.MathUtils.lerp(avatar.bodyPitch ?? 0, targetBodyPitch, 1 - Math.exp(-BODY_PITCH_RESPONSE * dt));
      const stride = moving ? Math.sin(elapsed * 12) * 0.48 : 0;
      if (avatar.procedural && displayPose === "stand" && avatar.leftLeg && avatar.rightLeg && avatar.leftArm && avatar.rightArm) {
        avatar.leftLeg.rotation.x = stride;
        avatar.rightLeg.rotation.x = -stride;
        if (avatar.state.role === "hunter") {
          const hunterPitch = this.hunterAimPitch(avatar);
          const hunterYaw = shortestAngle(avatar.root.rotation.y, this.hunterAimYaw(avatar));
          avatar.leftArm.position.set(-0.63, 1.15, 0);
          avatar.rightArm.position.set(0.48, 1.42, -0.46);
          avatar.leftArm.rotation.set(-stride * 0.2, 0, -0.08);
          avatar.rightArm.rotation.order = "YXZ";
          avatar.rightArm.rotation.set(-Math.PI / 2 + hunterPitch, hunterYaw, 0);
        } else {
          avatar.leftArm.position.set(-0.63, 1.15, 0);
          avatar.rightArm.position.set(0.63, 1.15, 0);
          avatar.leftArm.rotation.set(-stride * 0.65, 0, 0);
          avatar.rightArm.rotation.set(stride * 0.65, 0, 0);
        }
      } else if (!avatar.procedural) {
        const running = moving && planarSpeed > GAME.hunterSpeed + 0.35;
        const movementInput = id === this.selfId ? this.input?.movement() : undefined;
        const straightSprint = movementInput
          ? movementInput.forward > 0 && Math.abs(movementInput.strafe) < 0.05
          : Math.abs(shortestAngle(avatar.root.rotation.y, avatar.targetYaw)) < 0.2;
        const clipName = avatar.state.role === "hunter"
          ? moving
            ? running ? HUNTER_RUN_CLIP : HUNTER_WALK_CLIP
            : HUNTER_IDLE_CLIP
          : displayPose !== "stand"
            ? POSE_CLIPS[displayPose]
            : moving
              ? running ? RUN_CLIP : WALK_CLIP
              : POSE_CLIPS.stand;
        const expectedSpeed = running
          ? avatar.state.role === "hunter" ? GAME.hunterSprintSpeed : GAME.sprintSpeed
          : avatar.state.role === "hunter" ? GAME.hunterSpeed : GAME.moveSpeed;
        const timeScale = moving ? THREE.MathUtils.clamp(planarSpeed / expectedSpeed, 0.7, 1.35) : 1;
        this.setAvatarAnimation(avatar, clipName, displayPose === "stand" && moving, timeScale);
        avatar.mixer?.update(dt);
        this.applyLocomotionArmPose(avatar, running, displayPose, straightSprint);
      }
      this.applyAvatarBodyPitch(avatar);
      this.applyHunterPointingArm(avatar);
      avatar.whistleRing.visible = avatar.state.whistlingUntil > Date.now();
      const recoilRemaining = Math.max(0, avatar.recoilUntil - renderTime);
      this.updateHunterWeaponTransform(avatar, recoilRemaining);
      if (avatar.whistleRing.visible) {
        const pulse = 1 + ((elapsed * 1.8) % 1) * 2.4;
        avatar.whistleRing.scale.setScalar(pulse);
        (avatar.whistleRing.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - (pulse - 1) / 2.4);
      }
    }

    const focus = selfAvatar?.state.alive ? selfAvatar : [...this.avatars.values()].find((avatar) => avatar.state.alive) ?? selfAvatar;
    if (focus) {
      this.input?.updateCamera(dt);
      const inputYaw = this.input?.yaw ?? focus.state.yaw;
      const yaw = inputYaw + (this.input?.cameraYawOffset ?? 0) + (this.paintView ? this.paintOrbitYaw : 0);
      const pitch = (this.input?.pitch ?? -0.2) + (this.input?.cameraPitchOffset ?? 0) + (this.paintView ? this.paintOrbitPitch : 0);
      if (this.firstPersonHunterActive && focus === selfAvatar) {
        const firstPersonPitch = THREE.MathUtils.clamp(pitch + HUNTER_NEUTRAL_INPUT_PITCH, -0.75, 0.45);
        const faceOffsetHorizontal = Math.cos(firstPersonPitch) * HUNTER_FIRST_PERSON_FACE_OFFSET;
        this.camera.position.set(
          focus.root.position.x - Math.sin(yaw) * faceOffsetHorizontal,
          focus.root.position.y + HUNTER_FIRST_PERSON_EYE_HEIGHT + Math.sin(firstPersonPitch) * HUNTER_FIRST_PERSON_FACE_OFFSET,
          focus.root.position.z - Math.cos(yaw) * faceOffsetHorizontal
        );
        this.camera.rotation.order = "YXZ";
        this.camera.rotation.set(firstPersonPitch, yaw, 0);
        if (this.camera.fov !== HUNTER_FIRST_PERSON_FOV) {
          this.camera.fov = HUNTER_FIRST_PERSON_FOV;
          this.camera.updateProjectionMatrix();
        }
        this.cameraRigInitialized = false;
      } else {
        if (this.camera.fov !== DEFAULT_CAMERA_FOV) {
          this.camera.fov = DEFAULT_CAMERA_FOV;
          this.camera.updateProjectionMatrix();
        }
      this.cameraDistance = THREE.MathUtils.lerp(this.cameraDistance, this.targetCameraDistance, 1 - Math.exp(-CAMERA_ZOOM_RESPONSE * dt));
      const distance = this.cameraDistance;
      const roleScale = focus.state.role === "hunter" ? GAME.hunterCameraScale : 1;
      const target = focus.root.position.clone().add(new THREE.Vector3(0, POSE_CAMERA_HEIGHT[focus.state.pose] * roleScale, 0));
      if (!this.cameraRigInitialized) {
        this.cameraFocus.copy(target);
        this.cameraOrbitYaw = yaw;
        this.cameraOrbitPitch = pitch;
      } else {
        this.cameraFocus.lerp(target, 1 - Math.exp(-CAMERA_FOCUS_RESPONSE * dt));
        this.cameraOrbitYaw += shortestAngle(this.cameraOrbitYaw, yaw) * (1 - Math.exp(-CAMERA_ORBIT_RESPONSE * dt));
        this.cameraOrbitPitch = THREE.MathUtils.lerp(
          this.cameraOrbitPitch,
          pitch,
          1 - Math.exp(-CAMERA_ORBIT_RESPONSE * dt)
        );
      }
      const horizontal = Math.cos(this.cameraOrbitPitch) * distance;
      const desired = this.cameraFocus.clone().add(new THREE.Vector3(
        Math.sin(this.cameraOrbitYaw) * horizontal,
        CAMERA_VERTICAL_LIFT + Math.sin(-this.cameraOrbitPitch) * distance,
        Math.cos(this.cameraOrbitYaw) * horizontal
      ));
      const safeDesired = this.resolveCameraObstruction(this.cameraFocus, desired);
      if (!this.cameraRigInitialized) {
        this.camera.position.copy(safeDesired);
        this.cameraRigInitialized = true;
      } else {
        this.camera.position.lerp(safeDesired, 1 - Math.exp(-CAMERA_POSITION_RESPONSE * dt));
      }
      this.camera.lookAt(this.cameraFocus);
      }
    } else {
      this.cameraRigInitialized = false;
      this.camera.position.set(18, 16, 22);
      this.camera.lookAt(0, 1, 0);
    }
    for (const task of [...this.beforeRenderTasks]) {
      this.beforeRenderTasks.delete(task);
      task();
    }
    this.renderer.render(this.scene, this.camera);
  };

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private resolveCameraObstruction(target: THREE.Vector3, desired: THREE.Vector3): THREE.Vector3 {
    const offset = desired.clone().sub(target);
    const distance = offset.length();
    if (distance <= MIN_CAMERA_COLLISION_DISTANCE) return desired;
    if (isCameraPositionSafe(desired)) return desired;

    let near = MIN_CAMERA_COLLISION_DISTANCE / distance;
    let far = 1;
    for (let step = 0; step < CAMERA_COLLISION_SEARCH_STEPS; step += 1) {
      const mid = (near + far) / 2;
      const candidate = target.clone().lerp(desired, mid);
      if (isCameraPositionSafe(candidate)) near = mid;
      else far = mid;
    }
    return target.clone().lerp(desired, Math.max(0, near - (CAMERA_COLLISION_BUFFER / distance)));
  }
}

function isCameraPositionSafe(position: THREE.Vector3): boolean {
  const worldLimit = (WORLD_SIZE / 2) - CAMERA_COLLISION_RADIUS;
  if (position.x < -worldLimit || position.x > worldLimit || position.z < -worldLimit || position.z > worldLimit) return false;
  if (position.y < CAMERA_COLLISION_RADIUS || position.y > CAMERA_MAX_WORLD_HEIGHT) return false;
  for (const box of WORLD_BOXES) {
    if (!box.solid) continue;
    if (
      position.x >= box.position[0] - box.size[0] / 2 - CAMERA_COLLISION_RADIUS
      && position.x <= box.position[0] + box.size[0] / 2 + CAMERA_COLLISION_RADIUS
      && position.y >= box.position[1] - box.size[1] / 2 - CAMERA_COLLISION_RADIUS
      && position.y <= box.position[1] + box.size[1] / 2 + CAMERA_COLLISION_RADIUS
      && position.z >= box.position[2] - box.size[2] / 2 - CAMERA_COLLISION_RADIUS
      && position.z <= box.position[2] + box.size[2] / 2 + CAMERA_COLLISION_RADIUS
    ) return false;
  }
  for (const hull of WORLD_HULLS) {
    if (!hull.solid || hull.vertices.length < 4) continue;
    const footprint = worldHullFootprint(hull);
    if (hull.triangles?.length) {
      const top = worldHullHeightAt(hull, position.x, position.z);
      if (top !== undefined && position.y >= footprint.minY - CAMERA_COLLISION_RADIUS && position.y <= top + CAMERA_COLLISION_RADIUS) return false;
      continue;
    }
    if (position.y < footprint.minY - CAMERA_COLLISION_RADIUS || position.y > footprint.maxY + CAMERA_COLLISION_RADIUS) continue;
    if (pointInsideExpandedHull(position.x, position.z, footprint.points, CAMERA_COLLISION_RADIUS)) return false;
  }
  return true;
}

function pointInsideExpandedHull(
  x: number,
  z: number,
  points: readonly (readonly [number, number])[],
  radius: number
): boolean {
  if (points.length < 3) return false;
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]!;
    const end = points[(index + 1) % points.length]!;
    const edgeX = end[0] - start[0];
    const edgeZ = end[1] - start[1];
    const length = Math.hypot(edgeX, edgeZ);
    if (length <= Number.EPSILON) continue;
    const normalX = edgeZ / length;
    const normalZ = -edgeX / length;
    if ((x - start[0]) * normalX + (z - start[1]) * normalZ > radius) return false;
  }
  return true;
}

function createHunterCarryClips(clips: THREE.AnimationClip[]): THREE.AnimationClip[] {
  const pose = clips.find((clip) => clip.name === HUNTER_IDLE_CLIP);
  if (!pose) return [];
  const poseTracks = pose.tracks.filter(isHunterUpperBodyTrack);
  const merged: THREE.AnimationClip[] = [];
  for (const [baseName, carryName] of [[WALK_CLIP, HUNTER_WALK_CLIP], [RUN_CLIP, HUNTER_RUN_CLIP]] as const) {
    const base = clips.find((clip) => clip.name === baseName);
    if (!base) continue;
    const tracks = [
      ...base.tracks.filter((track) => !isHunterUpperBodyTrack(track)).map((track) => track.clone()),
      ...poseTracks.map((track) => track.clone())
    ];
    merged.push(new THREE.AnimationClip(carryName, base.duration, tracks));
  }
  return merged;
}

function isHunterUpperBodyTrack(track: THREE.KeyframeTrack): boolean {
  const separator = track.name.lastIndexOf(".");
  const target = (separator >= 0 ? track.name.slice(0, separator) : track.name).replace(/[^a-z0-9]/gi, "").toLowerCase();
  return HUNTER_POSE_BONES.some((bone) => target.endsWith(bone.replace(/[^a-z0-9]/gi, "").toLowerCase()));
}

function createShotgun(template?: THREE.Group): { weapon: THREE.Group; muzzle: THREE.Object3D } {
  const weapon = new THREE.Group();
  weapon.name = "MecchaShotgun";
  if (template) {
    const visual = template.clone(true);
    visual.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(visual);
    const size = bounds.getSize(new THREE.Vector3());
    const scale = 1.34 / Math.max(size.z, 0.001);
    visual.scale.setScalar(scale);
    // The source model's barrel points toward +Z; the character and muzzle
    // effects use -Z as forward.
    visual.rotation.y = Math.PI;
    visual.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
    });
    weapon.add(visual);

    const muzzle = new THREE.Object3D();
    muzzle.name = "ShotgunMuzzle";
    muzzle.position.set(0, 0.045 * scale, -bounds.max.z * scale);
    weapon.add(muzzle);
    return { weapon, muzzle };
  }

  const black = new THREE.MeshStandardMaterial({ color: "#11171b", roughness: 0.38, metalness: 0.62 });
  const dark = new THREE.MeshStandardMaterial({ color: "#252d31", roughness: 0.72, metalness: 0.18 });
  const steel = new THREE.MeshStandardMaterial({ color: "#536169", roughness: 0.28, metalness: 0.82 });

  const addBox = (size: [number, number, number], position: [number, number, number], material: THREE.Material, rotationZ = 0): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(...position);
    mesh.rotation.z = rotationZ;
    mesh.castShadow = true;
    weapon.add(mesh);
    return mesh;
  };
  const addTube = (radius: number, length: number, position: [number, number, number], material: THREE.Material): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 12), material);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(...position);
    mesh.castShadow = true;
    weapon.add(mesh);
    return mesh;
  };

  addBox([0.32, 0.28, 0.48], [0, 0, -0.18], black);
  addBox([0.25, 0.2, 0.38], [0, 0.01, 0.24], dark);
  addBox([0.18, 0.38, 0.16], [0, -0.2, 0.21], dark, -0.25);
  addBox([0.09, 0.05, 0.4], [0, 0.17, -0.2], steel);
  addTube(0.055, 0.78, [0, 0.075, -0.78], steel);
  addTube(0.07, 0.68, [0, -0.085, -0.7], black);
  addBox([0.37, 0.29, 0.35], [0, -0.015, -0.56], dark);

  // Ribbed pump and twin muzzle rings give the same chunky silhouette as the
  // licensed visual reference without redistributing its mesh.
  for (let index = 0; index < 5; index += 1) {
    addBox([0.39, 0.305, 0.025], [0, -0.015, -0.42 - index * 0.07], black);
  }
  for (const y of [0.075, -0.085]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(y > 0 ? 0.066 : 0.082, 0.014, 6, 16), black);
    ring.position.set(0, y, -1.17);
    ring.castShadow = true;
    weapon.add(ring);
  }

  const stripeColors = ["#35d6c7", "#8d68cf", "#f05b72", "#f2ad3d", "#a9cf4f"];
  stripeColors.forEach((color, index) => {
    const stripe = addBox(
      [0.342, 0.292, 0.034],
      [0, 0, -0.02 + index * 0.042],
      new THREE.MeshStandardMaterial({ color, roughness: 0.58, metalness: 0.05 })
    );
    stripe.renderOrder = 2;
  });

  const muzzle = new THREE.Object3D();
  muzzle.name = "ShotgunMuzzle";
  muzzle.position.set(0, 0.075, -1.2);
  weapon.add(muzzle);
  weapon.scale.setScalar(HUNTER_WEAPON_SCALE);
  return { weapon, muzzle };
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) material.dispose();
  });
}

function getHitMaterial(mesh: THREE.Mesh, faceIndex: number | null | undefined): THREE.Material | undefined {
  if (!Array.isArray(mesh.material)) return mesh.material;
  if (faceIndex == null) return mesh.material[0];
  const vertexOffset = faceIndex * 3;
  const group = mesh.geometry.groups.find(({ start, count }) => vertexOffset >= start && vertexOffset < start + count);
  return mesh.material[group?.materialIndex ?? 0];
}

function isVisibleInScene(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function removeLatestPaintAction(strokes: PaintStroke[], actionId: string): void {
  const lastStroke = strokes.at(-1);
  if (lastStroke?.actionId !== actionId) return;
  let firstStroke = strokes.length - 1;
  while (firstStroke > 0 && strokes[firstStroke - 1]?.actionId === actionId) firstStroke -= 1;
  strokes.splice(firstStroke);
}

/**
 * Keeps the character's normal base color opaque while treating the canvas as
 * a paint-only RGBA layer. Transparent canvas pixels leave the base untouched.
 */
function createPaintLayerMaterial(baseColor: string, texture: THREE.CanvasTexture): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: baseColor,
    map: texture,
    roughness: 1,
    metalness: 0
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `
#ifdef USE_MAP
  vec4 paintLayerColor = texture2D(map, vMapUv);
  vec3 paintColor = paintLayerColor.rgb / max(paintLayerColor.a, 0.0001);
  diffuseColor.rgb = mix(diffuseColor.rgb, paintColor, paintLayerColor.a);
#endif
      `
    );
  };
  material.customProgramCacheKey = () => "mechfall-transparent-paint-layer-v1";
  return material;
}

function drawUvPaintDot(surface: PaintSurface, stroke: PaintStroke): void {
  const context = surface.context;
  const x = stroke.u * surface.canvas.width;
  const y = (1 - stroke.v) * surface.canvas.height;
  const radius = Math.max(2, stroke.size * surface.canvas.width);
  context.fillStyle = stroke.color;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
}

function drawProjectedFaceStroke(surface: PaintSurface, stroke: PaintStroke): boolean {
  if (
    stroke.face === undefined
    || !Number.isFinite(stroke.brushUx)
    || !Number.isFinite(stroke.brushVx)
    || !Number.isFinite(stroke.brushUy)
    || !Number.isFinite(stroke.brushVy)
  ) return false;
  const geometry = surface.mesh.geometry;
  const uvs = geometry.getAttribute("uv");
  const positions = geometry.getAttribute("position");
  const face = Math.floor(stroke.face);
  const faceCount = geometry.index ? Math.floor(geometry.index.count / 3) : Math.floor(positions.count / 3);
  if (!uvs || face < 0 || face >= faceCount) return false;
  const vertices = paintFaceVertices(geometry, face);
  const brushDeterminant = stroke.brushUx! * stroke.brushVy! - stroke.brushUy! * stroke.brushVx!;
  let localEndX = 0;
  let localEndY = 0;
  if (Number.isFinite(stroke.brushEndU) && Number.isFinite(stroke.brushEndV) && Math.abs(brushDeterminant) > 1e-10) {
    const endU = stroke.brushEndU! - stroke.u;
    const endV = stroke.brushEndV! - stroke.v;
    localEndX = THREE.MathUtils.clamp((endU * stroke.brushVy! - stroke.brushUy! * endV) / brushDeterminant, -100, 100);
    localEndY = THREE.MathUtils.clamp((stroke.brushUx! * endV - endU * stroke.brushVx!) / brushDeterminant, -100, 100);
  }
  const context = surface.context;
  context.save();
  context.beginPath();
  for (let corner = 0; corner < 3; corner += 1) {
    const vertex = vertices[corner]!;
    const x = uvs.getX(vertex) * surface.canvas.width;
    const y = (1 - uvs.getY(vertex)) * surface.canvas.height;
    if (corner === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
  context.clip();
  context.setTransform(
    stroke.brushUx! * surface.canvas.width,
    -stroke.brushVx! * surface.canvas.height,
    stroke.brushUy! * surface.canvas.width,
    -stroke.brushVy! * surface.canvas.height,
    stroke.u * surface.canvas.width,
    (1 - stroke.v) * surface.canvas.height
  );
  context.fillStyle = stroke.color;
  tracePaintCapsule(context, localEndX, localEndY);
  context.fill();
  context.restore();

  // Repeat only the touched triangle edges into the atlas padding. Without
  // this, linear texture filtering pulls transparent texels into the shared
  // edge and exposes hairline base-color seams through an otherwise solid dab.
  context.save();
  context.setTransform(
    stroke.brushUx! * surface.canvas.width,
    -stroke.brushVx! * surface.canvas.height,
    stroke.brushUy! * surface.canvas.width,
    -stroke.brushVy! * surface.canvas.height,
    stroke.u * surface.canvas.width,
    (1 - stroke.v) * surface.canvas.height
  );
  tracePaintCapsule(context, localEndX, localEndY);
  context.clip();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.beginPath();
  for (let corner = 0; corner < 3; corner += 1) {
    const vertex = vertices[corner]!;
    const x = uvs.getX(vertex) * surface.canvas.width;
    const y = (1 - uvs.getY(vertex)) * surface.canvas.height;
    if (corner === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
  context.strokeStyle = stroke.color;
  context.lineWidth = 4;
  context.lineJoin = "round";
  context.stroke();
  context.restore();
  return true;
}

function tracePaintCapsule(context: CanvasRenderingContext2D, endX: number, endY: number): void {
  const length = Math.hypot(endX, endY);
  context.beginPath();
  if (length < 1e-5) {
    context.arc(0, 0, 1, 0, Math.PI * 2);
    return;
  }
  const normalX = -endY / length;
  const normalY = endX / length;
  const angle = Math.atan2(endY, endX);
  context.moveTo(normalX, normalY);
  context.lineTo(endX + normalX, endY + normalY);
  context.arc(endX, endY, 1, angle + Math.PI / 2, angle - Math.PI / 2, true);
  context.lineTo(-normalX, -normalY);
  context.arc(0, 0, 1, angle - Math.PI / 2, angle + Math.PI / 2, true);
  context.closePath();
}

function fillPaintFace(surface: PaintSurface, vertices: readonly [number, number, number], color: string): void {
  const uvs = surface.mesh.geometry.getAttribute("uv");
  const context = surface.context;
  context.beginPath();
  for (let corner = 0; corner < 3; corner += 1) {
    const vertex = vertices[corner]!;
    const x = uvs.getX(vertex) * surface.canvas.width;
    const y = (1 - uvs.getY(vertex)) * surface.canvas.height;
    if (corner === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
  context.fillStyle = color;
  context.fill();
  context.strokeStyle = color;
  context.lineWidth = 4;
  context.lineJoin = "round";
  context.stroke();
  surface.texture.needsUpdate = true;
}

function paintFaceVertices(geometry: THREE.BufferGeometry, face: number): [number, number, number] {
  return [0, 1, 2].map((corner) => geometry.index?.getX(face * 3 + corner) ?? face * 3 + corner) as [number, number, number];
}

function roundPaintValue(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function shortestAngle(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

const PAINT_TEXTURE_SIZE = 1024;
const CHARACTER_HEIGHT = 2.45;
const CLING_VISUAL_INSET = 0.26;
const CLING_VISUAL_RESPONSE = 24;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const DEFAULT_CAMERA_FOV = 58;
const HUNTER_FIRST_PERSON_FOV = 72;
const HUNTER_NEUTRAL_INPUT_PITCH = 0.22;
const HUNTER_FIRST_PERSON_EYE_HEIGHT = GAME.hunterEyeHeight;
const HUNTER_FIRST_PERSON_FACE_OFFSET = 0.18;
const HUNTER_WEAPON_SCALE = 1.06;
const HUNTER_WEAPON_GRIP_POSITION = new THREE.Vector3(0, -0.257, 0.373);
const HUNTER_WEAPON_FINE_OFFSET = new THREE.Vector3(-0.2, -0.2, 0.04);
const CAMERA_COLLISION_RADIUS = 0.34;
const CAMERA_COLLISION_BUFFER = 0.18;
const CAMERA_COLLISION_SEARCH_STEPS = 8;
const MIN_CAMERA_COLLISION_DISTANCE = 0.45;
const CAMERA_VERTICAL_LIFT = 2.35;
const CAMERA_MAX_WORLD_HEIGHT = Math.max(24, WORLD_SIZE * 0.5);
const CAMERA_ZOOM_RESPONSE = 4.5;
const CAMERA_FOCUS_RESPONSE = 6;
const CAMERA_ORBIT_RESPONSE = 18;
const CAMERA_POSITION_RESPONSE = 22;
const LOCAL_TURN_RESPONSE = 18;
const REMOTE_TURN_RESPONSE = 18;
const MAX_BODY_PITCH_UP = Math.PI / 2;
const MAX_BODY_PITCH_DOWN = 1.85;
const BODY_PITCH_STRENGTH = 3.3;
const BODY_PITCH_RESPONSE = 16;
const HUNTER_BODY_PITCH_STRENGTH = 1.25;
const BODY_PITCH_BONES = new Map<string, number>([
  ["bone001", 0.42],
  ["bone002", 0.28],
  ["bone003", 0.2],
  ["bone004", 0.1]
]);
const LOCOMOTION_ARM_POSE = new Map([
  ["upper_armR", new THREE.Euler(-0.04, 0.02, 0.96)],
  ["lower_armR", new THREE.Euler(-0.06, -0.02, 0.04)],
  ["upper_armL", new THREE.Euler(-0.04, -0.02, -0.96)],
  ["lower_armL", new THREE.Euler(-0.06, 0.02, -0.04)]
] as const);
type LocomotionArmBoneName = "upper_armR" | "lower_armR" | "upper_armL" | "lower_armL";
const LOCOMOTION_ARM_POSE_BLEND = 0.72;
const WALK_CLIP = "ChameleonMan|Walking";
const RUN_CLIP = "ChameleonMan|Running";
const HUNTER_IDLE_CLIP = "ChameleonMan|Pose_Straight";
const HUNTER_WALK_CLIP = "ChameleonMan|WalkingWithShotgun";
const HUNTER_RUN_CLIP = "ChameleonMan|RunningWithShotgun";
const HUNTER_POSE_BONES = ["Bone.001", "shoulder.R", "upper_arm.R", "lower_arm.R", "hand.R", "shoulder.L", "upper_arm.L", "lower_arm.L", "hand.L"] as const;

function hunterAimRadians(state: PlayerState): number {
  return THREE.MathUtils.clamp((state.aimPitch ?? -HUNTER_NEUTRAL_INPUT_PITCH) + HUNTER_NEUTRAL_INPUT_PITCH, -0.75, 0.45);
}

function hunterAimYaw(state: PlayerState): number {
  return state.aimYaw ?? state.yaw;
}

const POSE_CLIPS: Record<Pose, string> = {
  stand: "ChameleonMan|Pose_Straight",
  aPose: "ChameleonMan|Pose_A",
  backBend: "ChameleonMan|Pose_BackBend",
  bridge: "ChameleonMan|Pose_Bridge",
  crossLegged: "ChameleonMan|Pose_CrossLegged",
  crouchedFetal: "ChameleonMan|Pose_CrouchedFetal",
  curledUp: "ChameleonMan|Pose_CurledUpSit",
  fetal: "ChameleonMan|Pose_FetalPose",
  handOnHip: "ChameleonMan|Pose_HandOnHip",
  layDown: "ChameleonMan|Pose_LayDown",
  handUp: "ChameleonMan|Pose_LeftHandUp",
  mermaid: "ChameleonMan|Pose_MermaidSit",
  openWide: "ChameleonMan|Pose_OpenWide",
  sideLying: "ChameleonMan|Pose_SideLying",
  sit: "ChameleonMan|Pose_Sit",
  tPose: "ChameleonMan|Pose_T",
  tree: "ChameleonMan|Pose_Tree",
  wideSquat: "ChameleonMan|Pose_WideSquat"
};

const COMPACT_POSES = new Set<Pose>([
  "bridge",
  "crossLegged",
  "crouchedFetal",
  "curledUp",
  "fetal",
  "layDown",
  "mermaid",
  "sideLying",
  "sit",
  "wideSquat"
]);

const POSE_CAMERA_HEIGHT: Record<Pose, number> = {
  stand: 1.35,
  aPose: 1.35,
  backBend: 0.95,
  bridge: 0.55,
  crossLegged: 0.75,
  crouchedFetal: 0.65,
  curledUp: 0.7,
  fetal: 0.55,
  handOnHip: 1.35,
  layDown: 0.45,
  handUp: 1.4,
  mermaid: 0.72,
  openWide: 1.25,
  sideLying: 0.45,
  sit: 0.8,
  tPose: 1.35,
  tree: 1.15,
  wideSquat: 0.9
};
