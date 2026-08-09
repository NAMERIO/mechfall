import * as THREE from "three";
import {
  WORLD_BOXES,
  WORLD_SIZE,
  type PaintPart,
  type PaintStroke,
  type PlayerPaintState,
  type PlayerState,
  type ServerSnapshot
} from "@mechfall/shared";
import type { InputController } from "./InputController.ts";

interface PaintSurface {
  mesh: THREE.Mesh;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  material: THREE.MeshStandardMaterial;
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
  body: THREE.Mesh;
  head: THREE.Mesh;
  leftArm: THREE.Mesh;
  rightArm: THREE.Mesh;
  leftLeg: THREE.Mesh;
  rightLeg: THREE.Mesh;
  hunterMark: THREE.Group;
  whistleRing: THREE.Mesh;
  state: PlayerState;
}

export class WorldRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(58, 1, 0.1, 110);
  private readonly clock = new THREE.Clock();
  private readonly avatars = new Map<string, Avatar>();
  private readonly sampleSurfaces: THREE.Object3D[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly pendingPaint = new Map<string, PaintStroke[]>();
  private selfId = "";
  private input?: InputController;
  private running = true;
  private paintView = false;
  private paintOrbitYaw = 0;
  private paintOrbitPitch = 0;

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
    this.buildLighting();
    this.buildWorld();
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.animate();
  }

  bindInput(input: InputController): void {
    this.input = input;
  }

  setPaintView(active: boolean): void {
    this.paintView = active;
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

  applySnapshot(snapshot: ServerSnapshot): void {
    this.selfId = snapshot.selfId;
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
      if (avatar.baseColor !== player.color) {
        avatar.baseColor = player.color;
        this.redrawPaint(avatar);
      }
      for (const surface of avatar.paintSurfaces.values()) surface.material.roughness = player.pose === "blob" ? 0.36 : 0.7;
      avatar.root.visible = player.alive;
      avatar.hunterMark.visible = player.role === "hunter";
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
    const hits = this.raycaster.intersectObjects(this.sampleSurfaces, false);
    for (const hit of hits) {
      const color = hit.object.userData.sampleColor as string | undefined;
      if (color) return color;
    }
    return undefined;
  }

  paintAtScreen(clientX: number, clientY: number, color: string, size: number): PaintStroke | undefined {
    const avatar = this.avatars.get(this.selfId);
    if (!avatar?.state.alive || avatar.state.role !== "hider") return undefined;
    this.setRayFromScreen(clientX, clientY);
    const meshes = [...avatar.paintSurfaces.values()].map((surface) => surface.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    const part = hit?.object.userData.paintPart as PaintPart | undefined;
    if (!hit?.uv || !part) return undefined;
    const stroke: PaintStroke = { part, u: hit.uv.x, v: hit.uv.y, color, size };
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

  flashTag(): void {
    const light = new THREE.PointLight("#ff594f", 12, 9);
    const self = this.avatars.get(this.selfId);
    if (!self) return;
    light.position.copy(self.root.position).add(new THREE.Vector3(0, 1.4, 0));
    this.scene.add(light);
    window.setTimeout(() => this.scene.remove(light), 90);
  }

  destroy(): void {
    this.running = false;
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
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE),
      new THREE.MeshStandardMaterial({ color: "#c8b899", roughness: 0.92, metalness: 0 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.userData.sampleColor = "#c8b899";
    this.sampleSurfaces.push(floor);
    this.scene.add(floor);

    const grid = new THREE.GridHelper(WORLD_SIZE, 42, "#8f846f", "#a99d83");
    grid.position.y = 0.008;
    const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
    for (const material of materials) {
      material.opacity = 0.22;
      material.transparent = true;
    }
    this.scene.add(grid);

    const zoneGeometry = new THREE.PlaneGeometry(7, 5);
    for (const [x, z, color, rotation] of [
      [-13, -5, "#d9694d", -0.15], [9, 13, "#4d9f92", 0.1], [9, -15, "#d8ae44", -0.08], [-5, 15, "#7571a4", 0.18]
    ] as const) {
      const zone = new THREE.Mesh(zoneGeometry, new THREE.MeshStandardMaterial({ color, roughness: 0.95 }));
      zone.rotation.set(-Math.PI / 2, 0, rotation);
      zone.position.set(x, 0.012, z);
      zone.receiveShadow = true;
      zone.userData.sampleColor = color;
      this.sampleSurfaces.push(zone);
      this.scene.add(zone);
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
      this.addBoxDetails(mesh, box.kind);
    }

    this.addFactoryDetails();
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

  private createAvatar(state: PlayerState): Avatar {
    const root = new THREE.Group();
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
      const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.68, metalness: 0.02 });
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
    root.add(body, head, leftArm, rightArm, leftLeg, rightLeg);

    for (const x of [-0.17, 0.17]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), dark);
      eye.position.set(x, 2.12, -0.45);
      root.add(eye);
    }

    const hunterMark = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.055, 8, 24), new THREE.MeshBasicMaterial({ color: "#ff594f" }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 2.55;
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.48, 6), dark);
    antenna.position.y = 2.66;
    hunterMark.add(ring, antenna);
    root.add(hunterMark);

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
      body,
      head,
      leftArm,
      rightArm,
      leftLeg,
      rightLeg,
      hunterMark,
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
      surface.context.fillStyle = avatar.baseColor;
      surface.context.fillRect(0, 0, surface.canvas.width, surface.canvas.height);
      surface.texture.needsUpdate = true;
    }
    for (const stroke of avatar.strokes) this.drawStroke(avatar, stroke);
  }

  private drawStroke(avatar: Avatar, stroke: PaintStroke): void {
    const surface = avatar.paintSurfaces.get(stroke.part);
    if (!surface) return;
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

  private setPose(avatar: Avatar, pose: PlayerState["pose"]): void {
    const isBlob = pose === "blob";
    const isCrouch = pose === "crouch";
    avatar.body.scale.set(isBlob ? 1.35 : 1, isBlob ? 0.62 : isCrouch ? 0.72 : 1, isBlob ? 1.35 : 1);
    avatar.body.position.y = isBlob ? 0.56 : isCrouch ? 0.82 : 1.1;
    avatar.head.position.y = isBlob ? 0.77 : isCrouch ? 1.47 : 2.05;
    avatar.head.scale.setScalar(isBlob ? 0.72 : 1);
    avatar.leftArm.visible = !isBlob;
    avatar.rightArm.visible = !isBlob;
    avatar.leftLeg.visible = !isBlob;
    avatar.rightLeg.visible = !isBlob;
    avatar.leftLeg.position.y = isCrouch ? 0.25 : 0.42;
    avatar.rightLeg.position.y = isCrouch ? 0.25 : 0.42;
    avatar.hunterMark.position.y = isCrouch ? -0.45 : isBlob ? -1.15 : 0;
  }

  private animate = (): void => {
    if (!this.running) return;
    requestAnimationFrame(this.animate);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.elapsedTime;

    const renderTime = performance.now();
    for (const [id, avatar] of this.avatars) {
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

      const desiredYaw = id === this.selfId && this.input ? this.input.yaw : avatar.targetYaw;
      const yawResponse = id === this.selfId ? 1 : 1 - Math.exp(-18 * dt);
      avatar.root.rotation.y += shortestAngle(avatar.root.rotation.y, desiredYaw) * yawResponse;
      const moving = Math.hypot(avatar.state.velocity.x, avatar.state.velocity.z) > 0.3;
      const stride = moving ? Math.sin(elapsed * 12) * 0.48 : 0;
      if (avatar.state.pose === "stand") {
        avatar.leftLeg.rotation.x = stride;
        avatar.rightLeg.rotation.x = -stride;
        avatar.leftArm.rotation.x = -stride * 0.65;
        avatar.rightArm.rotation.x = stride * 0.65;
      }
      avatar.whistleRing.visible = avatar.state.whistlingUntil > Date.now();
      if (avatar.whistleRing.visible) {
        const pulse = 1 + ((elapsed * 1.8) % 1) * 2.4;
        avatar.whistleRing.scale.setScalar(pulse);
        (avatar.whistleRing.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - (pulse - 1) / 2.4);
      }
    }

    const selfAvatar = this.avatars.get(this.selfId);
    const focus = selfAvatar?.state.alive ? selfAvatar : [...this.avatars.values()].find((avatar) => avatar.state.alive) ?? selfAvatar;
    if (focus) {
      const inputYaw = this.input?.yaw ?? focus.state.yaw;
      const yaw = inputYaw + (this.paintView ? this.paintOrbitYaw : 0);
      const pitch = (this.input?.pitch ?? -0.2) + (this.paintView ? this.paintOrbitPitch : 0);
      const distance = 5.4;
      const target = focus.root.position.clone().add(new THREE.Vector3(0, focus.state.pose === "blob" ? 0.85 : 1.35, 0));
      const horizontal = Math.cos(pitch) * distance;
      const desired = target.clone().add(new THREE.Vector3(Math.sin(yaw) * horizontal, 1.2 + Math.sin(-pitch) * distance, Math.cos(yaw) * horizontal));
      this.camera.position.lerp(desired, 1 - Math.exp(-12 * dt));
      this.camera.lookAt(target);
    } else {
      this.camera.position.set(18, 16, 22);
      this.camera.lookAt(0, 1, 0);
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
}

function shortestAngle(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}
