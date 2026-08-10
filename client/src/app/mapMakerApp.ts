import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { WORLD_BOXES, WORLD_SIZE, type WorldBox } from "@mechfall/shared";

type BoxKind = WorldBox["kind"];
type EditableBox = {
  id: string;
  position: [number, number, number];
  size: [number, number, number];
  color: string;
  kind: BoxKind;
  solid: boolean;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
};
type TransformMode = "translate" | "rotate" | "scale";

const KIND_OPTIONS: BoxKind[] = ["wall", "crate", "table", "column", "planter"];
const PLAYER_RADIUS = 0.48;
const PLAYER_HEIGHT = 2.15;
const MOVE_SPEED = 6;
const DEFAULT_FLOOR_COLOR = "#2b3838";
const DEFAULT_BORDER_COLOR = "#de704e";
const FLOOR_SNAP_DISTANCE = 0.45;
const ROTATION_SNAP_DEGREES = 45;
const ROTATION_SNAP_RADIANS = THREE.MathUtils.degToRad(ROTATION_SNAP_DEGREES);
const BORDER_WALL_IDS = new Set(["north", "south", "west", "east"]);

document.body.className = "mapmaker-page";
document.body.innerHTML = `
  <main class="mapmaker-shell">
    <aside class="mapmaker-panel mapmaker-left">
      <header>
        <span>MECHFALL TOOL</span>
        <h1>MAP MAKER</h1>
        <p>Build collision boxes, place models, test movement, export code.</p>
      </header>
      <section class="mapmaker-tools">
        <button id="mm-add-box" type="button">ADD BOX</button>
        <button id="mm-duplicate-box" type="button">DUPLICATE</button>
        <button id="mm-delete-box" type="button">DELETE</button>
        <button id="mm-load-default" type="button">LOAD GAME MAP</button>
      </section>
      <section class="mapmaker-gizmo">
        <label>GIZMO MODE</label>
        <div>
          <button class="active" data-mm-transform-mode="translate" type="button">MOVE</button>
          <button data-mm-transform-mode="rotate" type="button">ROTATE</button>
          <button data-mm-transform-mode="scale" type="button">SCALE</button>
        </div>
        <label>ROTATION CLIP</label>
        <div class="mapmaker-rotation-tools">
          <button id="mm-rotation-snap" type="button">SNAP 45°</button>
          <button data-mm-yaw-set="0" type="button">STRAIGHT</button>
          <button data-mm-yaw-set="90" type="button">SIDE</button>
          <button data-mm-yaw-step="-45" type="button">-45°</button>
          <button data-mm-yaw-set="45" type="button">DIAGONAL</button>
          <button data-mm-yaw-step="45" type="button">+45°</button>
        </div>
        <small>Rotate snaps by 45°. Hold Shift for free rotate or free floor movement.</small>
      </section>
      <section class="mapmaker-world">
        <label>WORLD SIZE <input id="mm-world-size" type="number" min="8" max="120" step="1" value="${WORLD_SIZE}" /></label>
        <label>FLOOR COLOR <input id="mm-floor-color" type="color" value="${DEFAULT_FLOOR_COLOR}" /></label>
        <label>BORDER COLOR <input id="mm-border-color" type="color" value="${DEFAULT_BORDER_COLOR}" /></label>
        <button id="mm-apply-world" type="button">APPLY FLOOR</button>
        <button id="mm-rebuild-border" type="button">REBUILD BORDER WALLS</button>
        <small>Floor is visual. Border walls are real collision boxes you can edit after generating.</small>
      </section>
      <section class="mapmaker-import">
        <label>IMPORT MODEL <input id="mm-model-file" type="file" accept=".glb,.gltf,.zip" /></label>
        <button id="mm-model-bounds" type="button">COLLISION FROM MODEL BOUNDS</button>
        <button id="mm-model-meshes" type="button">COLLISION FROM MODEL MESHES</button>
        <small id="mm-status">Tip: GLB works best. Zip support needs extracted model files for now.</small>
      </section>
      <section class="mapmaker-test">
        <button id="mm-test-toggle" type="button">TEST COLLISION: OFF</button>
        <small>WASD moves the test player. Red = blocked.</small>
      </section>
      <section>
        <label>IMPORT EXPORTED JSON</label>
        <textarea id="mm-import-text" spellcheck="false" placeholder='Paste [{"id":"box","position":[0,1,0],"size":[2,2,2],...}]'></textarea>
        <button id="mm-import-map" type="button">IMPORT BOXES</button>
      </section>
    </aside>

    <section class="mapmaker-view">
      <div id="mm-canvas-host"></div>
      <div class="mapmaker-help">
        <b>Mouse</b> orbit / select boxes or models · <b>Gizmo</b> move / rotate / scale · <b>Rotate</b> snaps 45° · <b>Shift</b> free move/rotate
      </div>
    </section>

    <aside class="mapmaker-panel mapmaker-right">
      <header>
        <span>SELECTED ITEM</span>
        <strong id="mm-selected-title">NONE</strong>
      </header>
      <div class="mapmaker-fields">
        <label>ID <input id="mm-id" /></label>
        <label>KIND <select id="mm-kind">${KIND_OPTIONS.map((kind) => `<option value="${kind}">${kind}</option>`).join("")}</select></label>
        <label>COLOR <input id="mm-color" type="color" value="#d9564a" /></label>
        <label>SOLID <input id="mm-solid" type="checkbox" checked /></label>
        <label>X <input id="mm-pos-x" type="number" step="0.1" /></label>
        <label>Y <input id="mm-pos-y" type="number" step="0.1" /></label>
        <label>Z <input id="mm-pos-z" type="number" step="0.1" /></label>
        <label>W <input id="mm-size-x" type="number" min="0.1" step="0.1" /></label>
        <label>H <input id="mm-size-y" type="number" min="0.1" step="0.1" /></label>
        <label>D <input id="mm-size-z" type="number" min="0.1" step="0.1" /></label>
      </div>
      <section class="mapmaker-list-wrap">
        <label>BOXES</label>
        <div id="mm-box-list" class="mapmaker-box-list"></div>
      </section>
      <section class="mapmaker-export">
        <div>
          <button id="mm-export-json" type="button">EXPORT JSON</button>
          <button id="mm-export-code" type="button">EXPORT WORLD.TS CODE</button>
          <button id="mm-copy-export" type="button">COPY</button>
        </div>
        <textarea id="mm-export-text" spellcheck="false" readonly></textarea>
      </section>
    </aside>
  </main>
`;

const host = element<HTMLDivElement>("#mm-canvas-host");
const status = element<HTMLElement>("#mm-status");
const boxList = element<HTMLDivElement>("#mm-box-list");
const exportText = element<HTMLTextAreaElement>("#mm-export-text");
const selectedTitle = element<HTMLElement>("#mm-selected-title");
const inputs = {
  id: element<HTMLInputElement>("#mm-id"),
  kind: element<HTMLSelectElement>("#mm-kind"),
  color: element<HTMLInputElement>("#mm-color"),
  solid: element<HTMLInputElement>("#mm-solid"),
  px: element<HTMLInputElement>("#mm-pos-x"),
  py: element<HTMLInputElement>("#mm-pos-y"),
  pz: element<HTMLInputElement>("#mm-pos-z"),
  sx: element<HTMLInputElement>("#mm-size-x"),
  sy: element<HTMLInputElement>("#mm-size-y"),
  sz: element<HTMLInputElement>("#mm-size-z")
};
const worldInputs = {
  size: element<HTMLInputElement>("#mm-world-size"),
  floorColor: element<HTMLInputElement>("#mm-floor-color"),
  borderColor: element<HTMLInputElement>("#mm-border-color")
};

const scene = new THREE.Scene();
scene.background = new THREE.Color("#10191e");
scene.fog = new THREE.FogExp2("#10191e", 0.018);

const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 180);
camera.position.set(20, 18, 24);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.7));
renderer.shadowMap.enabled = true;
host.append(renderer.domElement);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 1.5, 0);
orbit.enableDamping = true;

const transform = new TransformControls(camera, renderer.domElement);
let transformMode: TransformMode = "translate";
transform.setMode("translate");
transform.addEventListener("dragging-changed", (event) => {
  orbit.enabled = !event.value;
});
transform.addEventListener("objectChange", () => {
  if (selected) {
    if (transformMode === "translate") snapBoxToFloor(selected);
    selected.position = roundTuple([selected.mesh.position.x, selected.mesh.position.y, selected.mesh.position.z]);
    fillFields(selected);
    renderList();
    exportJson();
    return;
  }
  if (selectedAsset) {
    if (transformMode === "translate") snapAssetToFloor(selectedAsset);
    if (transformMode === "rotate" && !isIgnoringFloorSnap()) snapObjectRotation(selectedAsset);
    selectedTitle.textContent = `ASSET: ${selectedAsset.name || "MODEL"}`;
    exportJson();
  }
});
scene.add(transform.getHelper());

scene.add(new THREE.HemisphereLight("#fff3d2", "#41515a", 2.2));
const sun = new THREE.DirectionalLight("#fff4cf", 3.2);
sun.position.set(-12, 24, 18);
sun.castShadow = true;
scene.add(sun);

let worldSize = WORLD_SIZE;
let floorColor = DEFAULT_FLOOR_COLOR;
let borderColor = DEFAULT_BORDER_COLOR;

const floor = new THREE.Mesh(new THREE.PlaneGeometry(worldSize, worldSize), new THREE.MeshStandardMaterial({ color: floorColor, roughness: 0.92 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

let grid = makeGrid(worldSize);
scene.add(grid);

let boxes: EditableBox[] = [];
let selected: EditableBox | undefined;
let selectedAsset: THREE.Object3D | undefined;
let importedModel: THREE.Group | undefined;
let testMode = false;
const keys = new Set<string>();
const testPlayer = makeTestPlayer();
scene.add(testPlayer);

loadBoxes(WORLD_BOXES.map(boxToEditableInput));
exportJson();

element<HTMLButtonElement>("#mm-add-box").addEventListener("click", () => {
  selectBox(addBox({ id: uniqueId("box"), position: [0, 1, 0], size: [2, 2, 2], color: "#d9564a", kind: "crate", solid: true }));
});
element<HTMLButtonElement>("#mm-duplicate-box").addEventListener("click", () => {
  if (!selected) return;
  selectBox(addBox({ ...boxToEditableInput(selected), id: uniqueId(`${selected.id}-copy`), position: [selected.position[0] + 1, selected.position[1], selected.position[2] + 1] }));
});
element<HTMLButtonElement>("#mm-delete-box").addEventListener("click", deleteSelected);
element<HTMLButtonElement>("#mm-load-default").addEventListener("click", resetDefaultMap);
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mm-transform-mode]")) {
  button.addEventListener("click", () => setTransformMode(button.dataset.mmTransformMode as TransformMode));
}
element<HTMLButtonElement>("#mm-rotation-snap").addEventListener("click", snapSelectedRotation);
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mm-yaw-set]")) {
  button.addEventListener("click", () => setSelectedYaw(Number(button.dataset.mmYawSet ?? 0)));
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mm-yaw-step]")) {
  button.addEventListener("click", () => stepSelectedYaw(Number(button.dataset.mmYawStep ?? 0)));
}
element<HTMLButtonElement>("#mm-apply-world").addEventListener("click", applyWorldSettings);
element<HTMLButtonElement>("#mm-rebuild-border").addEventListener("click", rebuildBorderWalls);
worldInputs.floorColor.addEventListener("input", applyWorldSettings);
worldInputs.size.addEventListener("change", applyWorldSettings);
worldInputs.borderColor.addEventListener("input", () => {
  borderColor = worldInputs.borderColor.value;
});
element<HTMLButtonElement>("#mm-model-bounds").addEventListener("click", createCollisionFromModelBounds);
element<HTMLButtonElement>("#mm-model-meshes").addEventListener("click", createCollisionFromModelMeshes);
element<HTMLButtonElement>("#mm-test-toggle").addEventListener("click", () => {
  testMode = !testMode;
  element<HTMLButtonElement>("#mm-test-toggle").textContent = `TEST COLLISION: ${testMode ? "ON" : "OFF"}`;
  testPlayer.visible = testMode;
});
element<HTMLInputElement>("#mm-model-file").addEventListener("change", (event) => {
  const input = event.currentTarget as HTMLInputElement;
  void importModel(input.files?.[0]);
});
element<HTMLButtonElement>("#mm-export-json").addEventListener("click", exportJson);
element<HTMLButtonElement>("#mm-export-code").addEventListener("click", exportCode);
element<HTMLButtonElement>("#mm-copy-export").addEventListener("click", () => void navigator.clipboard.writeText(exportText.value));
element<HTMLButtonElement>("#mm-import-map").addEventListener("click", importBoxesFromText);

for (const input of Object.values(inputs)) {
  input.addEventListener("input", applyFieldsToSelected);
}

renderer.domElement.addEventListener("pointerdown", (event) => {
  if ((transform as unknown as { dragging?: boolean }).dragging) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1));
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(boxes.map((box) => box.mesh), false)[0];
  if (hit) {
    selectBox(boxes.find((box) => box.mesh === hit.object));
    return;
  }
  if (importedModel) {
    const assetHit = raycaster.intersectObjects(getModelMeshes(importedModel), false)[0];
    if (assetHit) {
      selectAsset(importedModel);
      return;
    }
  }
  selectBox(undefined);
});

window.addEventListener("keydown", (event) => {
  keys.add(event.code);
  updateTransformSnapping();
});
window.addEventListener("keyup", (event) => {
  const wasIgnoringSnap = isIgnoringFloorSnap();
  keys.delete(event.code);
  if (wasIgnoringSnap && !isIgnoringFloorSnap() && transformMode === "rotate" && selectedAsset) {
    setRotationClipBaseToCurrent(selectedAsset);
    status.textContent = "Rotation clip reset from current facing. Next snapped rotate moves in 45° steps from here.";
  }
  updateTransformSnapping();
});
window.addEventListener("resize", resize);
resize();
animate();

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing map maker element: ${selector}`);
  return found;
}

function makeGrid(size: number): THREE.GridHelper {
  const helper = new THREE.GridHelper(size, Math.max(8, Math.round(size)), "#f4d24f", "#748580");
  (Array.isArray(helper.material) ? helper.material : [helper.material]).forEach((material) => {
    material.transparent = true;
    material.opacity = 0.22;
  });
  return helper;
}

function setTransformMode(mode: TransformMode): void {
  if (!["translate", "rotate", "scale"].includes(mode)) return;
  transformMode = mode;
  transform.setMode(mode);
  updateTransformSnapping();
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mm-transform-mode]")) {
    button.classList.toggle("active", button.dataset.mmTransformMode === mode);
  }
  status.textContent = mode === "rotate"
    ? `Gizmo mode: rotate. Snaps every ${ROTATION_SNAP_DEGREES}°. Hold Shift for free rotate.`
    : `Gizmo mode: ${mode === "translate" ? "move" : mode}.`;
}

function applyWorldSettings(): void {
  worldSize = Math.max(8, Math.min(120, numberInput(worldInputs.size, worldSize)));
  floorColor = worldInputs.floorColor.value || floorColor;
  borderColor = worldInputs.borderColor.value || borderColor;
  worldInputs.size.value = formatNumber(worldSize);
  worldInputs.floorColor.value = floorColor;
  worldInputs.borderColor.value = borderColor;

  floor.geometry.dispose();
  floor.geometry = new THREE.PlaneGeometry(worldSize, worldSize);
  (floor.material as THREE.MeshStandardMaterial).color.set(floorColor);

  scene.remove(grid);
  grid.geometry.dispose();
  (Array.isArray(grid.material) ? grid.material : [grid.material]).forEach((material) => material.dispose());
  grid = makeGrid(worldSize);
  scene.add(grid);
  exportJson();
}

function rebuildBorderWalls(): void {
  applyWorldSettings();
  for (const box of [...boxes]) {
    if (!BORDER_WALL_IDS.has(box.id)) continue;
    scene.remove(box.mesh);
    box.mesh.geometry.dispose();
    (box.mesh.material as THREE.Material).dispose();
  }
  boxes = boxes.filter((box) => !BORDER_WALL_IDS.has(box.id));

  const half = worldSize / 2;
  const thickness = 1;
  const height = 5;
  const reach = worldSize + thickness;
  const walls: Array<Omit<EditableBox, "mesh" | "edges">> = [
    { id: "north", position: [0, height / 2, -half], size: [reach, height, thickness], color: borderColor, kind: "wall", solid: true },
    { id: "south", position: [0, height / 2, half], size: [reach, height, thickness], color: borderColor, kind: "wall", solid: true },
    { id: "west", position: [-half, height / 2, 0], size: [thickness, height, reach], color: borderColor, kind: "wall", solid: true },
    { id: "east", position: [half, height / 2, 0], size: [thickness, height, reach], color: borderColor, kind: "wall", solid: true }
  ];
  const created = walls.map((wall) => addBox(wall));
  selectBox(created[0]);
  status.textContent = `Rebuilt ${formatNumber(worldSize)}x${formatNumber(worldSize)} map border collision.`;
  exportJson();
}

function resetDefaultMap(): void {
  worldSize = WORLD_SIZE;
  floorColor = DEFAULT_FLOOR_COLOR;
  borderColor = DEFAULT_BORDER_COLOR;
  worldInputs.size.value = formatNumber(worldSize);
  worldInputs.floorColor.value = floorColor;
  worldInputs.borderColor.value = borderColor;
  applyWorldSettings();
  loadBoxes(WORLD_BOXES.map(boxToEditableInput));
  status.textContent = "Loaded the current game map.";
}

function addBox(input: Omit<EditableBox, "mesh" | "edges">): EditableBox {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color: input.color, transparent: true, opacity: input.solid ? 0.42 : 0.18, roughness: 0.8 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: "#ff5e52", transparent: true, opacity: 0.85 }));
  mesh.add(edges);
  const box: EditableBox = { ...input, mesh, edges };
  boxes.push(box);
  scene.add(mesh);
  syncBoxMesh(box);
  renderList();
  return box;
}

function syncBoxMesh(box: EditableBox): void {
  box.mesh.name = box.id;
  box.mesh.position.set(...box.position);
  box.mesh.scale.set(...box.size);
  const material = box.mesh.material as THREE.MeshStandardMaterial;
  material.color.set(box.color);
  material.opacity = box.solid ? 0.42 : 0.18;
  (box.edges.material as THREE.LineBasicMaterial).color.set(selected === box ? "#f4d24f" : "#ff5e52");
  (box.edges.material as THREE.LineBasicMaterial).opacity = selected === box ? 1 : 0.85;
}

function isIgnoringFloorSnap(): boolean {
  return keys.has("ShiftLeft") || keys.has("ShiftRight");
}

function updateTransformSnapping(): void {
  transform.setRotationSnap(transformMode === "rotate" && !isIgnoringFloorSnap() ? ROTATION_SNAP_RADIANS : null);
}

function getRotatableTarget(): THREE.Object3D | undefined {
  return selectedAsset;
}

function snapSelectedRotation(): void {
  const target = getRotatableTarget();
  if (!target) {
    status.textContent = "Select an imported asset first to snap its rotation.";
    return;
  }
  snapObjectRotation(target);
  setRotationClipBaseToCurrent(target);
  status.textContent = "Snapped asset rotation and reset clip from current facing.";
  exportJson();
}

function setSelectedYaw(degrees: number): void {
  const target = getRotatableTarget();
  if (!target) {
    status.textContent = "Select an imported asset first to set straight/side/diagonal.";
    return;
  }
  target.rotation.x = snapAngle(target.rotation.x);
  target.rotation.y = THREE.MathUtils.degToRad(degrees) - getVisualYawOffset(target);
  target.rotation.z = snapAngle(target.rotation.z);
  target.updateMatrixWorld(true);
  setRotationClipBaseToCurrent(target);
  status.textContent = `Set asset yaw to ${degrees}° (${degrees === 0 ? "straight" : degrees === 90 ? "side" : "diagonal"}).`;
  exportJson();
}

function stepSelectedYaw(degrees: number): void {
  const target = getRotatableTarget();
  if (!target) {
    status.textContent = "Select an imported asset first to rotate it by 45°.";
    return;
  }
  target.rotation.y += THREE.MathUtils.degToRad(degrees);
  snapObjectRotation(target);
  setRotationClipBaseToCurrent(target);
  status.textContent = `Turned asset ${degrees > 0 ? "+" : ""}${degrees}° and clipped to ${ROTATION_SNAP_DEGREES}° angles.`;
  exportJson();
}

function snapObjectRotation(object: THREE.Object3D): void {
  const visualYaw = getVisualYaw(object);
  const baseYaw = getRotationClipBaseYaw(object);
  const snappedVisualYaw = baseYaw + snapAngle(visualYaw - baseYaw);
  object.rotation.set(
    snapAngle(object.rotation.x),
    object.rotation.y + snappedVisualYaw - visualYaw,
    snapAngle(object.rotation.z)
  );
  object.updateMatrixWorld(true);
}

function snapAngle(angle: number): number {
  return Math.round(angle / ROTATION_SNAP_RADIANS) * ROTATION_SNAP_RADIANS;
}

function getVisualYaw(object: THREE.Object3D): number {
  return object.rotation.y + getVisualYawOffset(object);
}

function getRotationClipBaseYaw(object: THREE.Object3D): number {
  return typeof object.userData.rotationClipBaseYaw === "number" ? object.userData.rotationClipBaseYaw : 0;
}

function setRotationClipBaseToCurrent(object: THREE.Object3D): void {
  object.userData.rotationClipBaseYaw = getVisualYaw(object);
}

function getVisualYawOffset(object: THREE.Object3D): number {
  if (typeof object.userData.visualYawOffset === "number") return object.userData.visualYawOffset;
  const offset = computeVisualYawOffset(object);
  object.userData.visualYawOffset = offset;
  return offset;
}

function computeVisualYawOffset(object: THREE.Object3D): number {
  object.updateMatrixWorld(true);
  const inverseRoot = object.matrixWorld.clone().invert();
  const point = new THREE.Vector3();
  const points: THREE.Vector2[] = [];

  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || points.length >= 2400) return;
    const position = child.geometry.getAttribute("position");
    if (!position) return;
    const stride = Math.max(1, Math.floor(position.count / 400));
    for (let index = 0; index < position.count && points.length < 2400; index += stride) {
      point.fromBufferAttribute(position, index);
      child.localToWorld(point);
      point.applyMatrix4(inverseRoot);
      points.push(new THREE.Vector2(point.x, point.z));
    }
  });

  if (points.length < 3) return 0;
  const mean = points.reduce((sum, item) => sum.add(item), new THREE.Vector2()).multiplyScalar(1 / points.length);
  let xx = 0;
  let xz = 0;
  let zz = 0;
  for (const item of points) {
    const x = item.x - mean.x;
    const z = item.y - mean.y;
    xx += x * x;
    xz += x * z;
    zz += z * z;
  }
  if (Math.max(xx, zz) <= 0.0001) return 0;
  return 0.5 * Math.atan2(2 * xz, xx - zz);
}

function snapBoxToFloor(box: EditableBox): void {
  if (isIgnoringFloorSnap()) return;
  const bottom = box.mesh.position.y - box.size[1] / 2;
  if (Math.abs(bottom) > FLOOR_SNAP_DISTANCE) return;
  box.mesh.position.y -= bottom;
}

function snapAssetToFloor(asset: THREE.Object3D): void {
  if (isIgnoringFloorSnap()) return;
  asset.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(asset);
  if (bounds.isEmpty() || Math.abs(bounds.min.y) > FLOOR_SNAP_DISTANCE) return;
  asset.position.y -= bounds.min.y;
  asset.updateMatrixWorld(true);
}

function selectBox(box: EditableBox | undefined): void {
  selected = box;
  selectedAsset = undefined;
  transform.detach();
  for (const item of boxes) syncBoxMesh(item);
  if (box) transform.attach(box.mesh);
  fillFields(box);
  renderList();
}

function selectAsset(asset: THREE.Object3D): void {
  selected = undefined;
  selectedAsset = asset;
  transform.detach();
  for (const item of boxes) syncBoxMesh(item);
  transform.attach(asset);
  fillFields(undefined);
  selectedTitle.textContent = `ASSET: ${asset.name || "MODEL"}`;
  status.textContent = "Asset selected. It snaps to the floor when close. Hold Shift while dragging to ignore snap.";
  renderList();
}

function fillFields(box: EditableBox | undefined): void {
  selectedTitle.textContent = box?.id ?? "NONE";
  for (const input of Object.values(inputs)) input.disabled = !box;
  if (!box) return;
  inputs.id.value = box.id;
  inputs.kind.value = box.kind;
  inputs.color.value = box.color;
  inputs.solid.checked = box.solid;
  inputs.px.value = formatNumber(box.position[0]);
  inputs.py.value = formatNumber(box.position[1]);
  inputs.pz.value = formatNumber(box.position[2]);
  inputs.sx.value = formatNumber(box.size[0]);
  inputs.sy.value = formatNumber(box.size[1]);
  inputs.sz.value = formatNumber(box.size[2]);
}

function applyFieldsToSelected(): void {
  if (!selected) return;
  selected.id = inputs.id.value.trim() || selected.id;
  selected.kind = (inputs.kind.value as BoxKind) || selected.kind;
  selected.color = inputs.color.value;
  selected.solid = inputs.solid.checked;
  selected.position = [numberInput(inputs.px, selected.position[0]), numberInput(inputs.py, selected.position[1]), numberInput(inputs.pz, selected.position[2])];
  selected.size = [
    Math.max(0.1, numberInput(inputs.sx, selected.size[0])),
    Math.max(0.1, numberInput(inputs.sy, selected.size[1])),
    Math.max(0.1, numberInput(inputs.sz, selected.size[2]))
  ];
  syncBoxMesh(selected);
  renderList();
  exportJson();
}

function renderList(): void {
  boxList.innerHTML = "";
  for (const box of boxes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = box === selected ? "active" : "";
    button.innerHTML = `<strong>${escapeHtml(box.id)}</strong><span>${box.kind} · ${box.size.map(formatNumber).join(" x ")}</span>`;
    button.addEventListener("click", () => selectBox(box));
    boxList.append(button);
  }
}

function deleteSelected(): void {
  if (selectedAsset) {
    if (selectedAsset === importedModel) importedModel = undefined;
    scene.remove(selectedAsset);
    disposeObject(selectedAsset);
    selectedAsset = undefined;
    transform.detach();
    fillFields(undefined);
    status.textContent = "Deleted selected asset.";
    exportJson();
    return;
  }
  if (!selected) return;
  scene.remove(selected.mesh);
  selected.mesh.geometry.dispose();
  (selected.mesh.material as THREE.Material).dispose();
  boxes = boxes.filter((box) => box !== selected);
  selectBox(boxes[0]);
  exportJson();
}

function loadBoxes(inputs: Array<Omit<EditableBox, "mesh" | "edges">>): void {
  for (const box of boxes) {
    scene.remove(box.mesh);
    box.mesh.geometry.dispose();
    (box.mesh.material as THREE.Material).dispose();
  }
  boxes = [];
  inputs.forEach((input) => addBox(input));
  selectBox(boxes[0]);
  exportJson();
}

async function importModel(file: File | undefined): Promise<void> {
  if (!file) return;
  if (file.name.toLowerCase().endsWith(".zip")) {
    status.textContent = "Zip import needs a zip parser. For now: extract the zip and import the .glb file.";
    return;
  }
  const url = URL.createObjectURL(file);
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    if (importedModel) {
      scene.remove(importedModel);
      disposeObject(importedModel);
    }
    importedModel = normalizeImportedModel(gltf.scene, file.name);
    scene.add(importedModel);
    snapAssetToFloor(importedModel);
    selectAsset(importedModel);
    status.textContent = `Loaded ${file.name}. Move it with the gizmo, then create hitboxes.`;
  } catch (error) {
    status.textContent = `Could not load model: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function normalizeImportedModel(model: THREE.Group, name: string): THREE.Group {
  const root = new THREE.Group();
  root.name = name;
  root.add(model);
  root.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(root);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const scale = Math.min(1, 30 / Math.max(size.x, size.y, size.z, 0.001));
  model.position.sub(center);
  root.scale.setScalar(scale);
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  return root;
}

function getModelMeshes(model: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  model.traverse((child) => {
    if (child instanceof THREE.Mesh) meshes.push(child);
  });
  return meshes;
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    (Array.isArray(child.material) ? child.material : [child.material]).forEach((material) => material.dispose());
  });
}

function createCollisionFromModelBounds(): void {
  if (!importedModel) {
    status.textContent = "Import a GLB model first.";
    return;
  }
  importedModel.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(importedModel);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  selectBox(addBox({
    id: uniqueId("model-bounds"),
    position: roundTuple([center.x, center.y, center.z]),
    size: roundTuple([size.x, size.y, size.z]),
    color: "#f4d24f",
    kind: "crate",
    solid: true
  }));
  exportJson();
}

function createCollisionFromModelMeshes(): void {
  if (!importedModel) {
    status.textContent = "Import a GLB model first.";
    return;
  }
  const created: EditableBox[] = [];
  importedModel.updateMatrixWorld(true);
  importedModel.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || created.length >= 80) return;
    const bounds = new THREE.Box3().setFromObject(child);
    if (bounds.isEmpty()) return;
    const size = bounds.getSize(new THREE.Vector3());
    if (Math.max(size.x, size.y, size.z) < 0.15) return;
    const center = bounds.getCenter(new THREE.Vector3());
    created.push(addBox({
      id: uniqueId(`mesh-${child.name || "part"}`.replace(/[^a-z0-9-_]/gi, "-").toLowerCase()),
      position: roundTuple([center.x, center.y, center.z]),
      size: roundTuple([size.x, size.y, size.z]),
      color: "#57b9a9",
      kind: "crate",
      solid: true
    }));
  });
  selectBox(created[0] ?? selected);
  status.textContent = `Created ${created.length} mesh collision box${created.length === 1 ? "" : "es"}.`;
  exportJson();
}

function exportJson(): void {
  exportText.value = JSON.stringify({
    worldSize,
    floorColor,
    borderColor,
    asset: importedModel ? assetToExport(importedModel) : undefined,
    boxes: boxes.map(boxToEditableInput)
  }, null, 2);
}

function exportCode(): void {
  const lines = boxes.map((box) => {
    const data = boxToEditableInput(box);
    return `  { id: ${JSON.stringify(data.id)}, position: [${data.position.join(", ")}], size: [${data.size.join(", ")}], color: ${JSON.stringify(data.color)}, kind: ${JSON.stringify(data.kind)}, solid: ${data.solid} },`;
  });
  exportText.value = `export const WORLD_SIZE = ${formatNumber(worldSize)};\nexport const WORLD_WALL_THICKNESS = 1;\n// Map maker floor color: ${floorColor}\n\nexport const WORLD_BOXES: readonly WorldBox[] = [\n${lines.join("\n")}\n] as const;`;
}

function importBoxesFromText(): void {
  try {
    const parsed = JSON.parse(element<HTMLTextAreaElement>("#mm-import-text").value) as unknown;
    const rawBoxes = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { boxes?: unknown }).boxes)
        ? (parsed as { boxes: unknown[] }).boxes
        : undefined;
    if (!rawBoxes) throw new Error("Expected an array or { boxes: [...] }");

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const payload = parsed as { worldSize?: unknown; floorColor?: unknown; borderColor?: unknown };
      if (Number.isFinite(Number(payload.worldSize))) worldInputs.size.value = String(payload.worldSize);
      if (typeof payload.floorColor === "string") worldInputs.floorColor.value = payload.floorColor;
      if (typeof payload.borderColor === "string") worldInputs.borderColor.value = payload.borderColor;
      applyWorldSettings();
    }

    loadBoxes(rawBoxes.map((rawBox, index) => {
      const box = rawBox as Partial<WorldBox>;
      return {
      id: String(box.id ?? uniqueId(`import-${index}`)),
      position: tuple(box.position, [0, 1, 0]),
      size: tuple(box.size, [2, 2, 2]),
      color: String(box.color ?? "#d9564a"),
      kind: KIND_OPTIONS.includes(box.kind as BoxKind) ? box.kind as BoxKind : "crate",
      solid: box.solid !== false
    };
    }));
    status.textContent = `Imported ${rawBoxes.length} collision boxes.`;
  } catch (error) {
    status.textContent = `Import failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function makeTestPlayer(): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: "#f5f0df", roughness: 0.75 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT - PLAYER_RADIUS * 2, 6, 14), material);
  body.position.y = PLAYER_HEIGHT / 2;
  group.add(body);
  group.position.set(0, 0, 0);
  group.visible = false;
  return group;
}

function moveTestPlayer(dt: number): void {
  if (!testMode) return;
  const forward = Number(keys.has("KeyW")) - Number(keys.has("KeyS"));
  const strafe = Number(keys.has("KeyD")) - Number(keys.has("KeyA"));
  const length = Math.hypot(forward, strafe);
  if (length <= 0) return;
  const cameraForward = new THREE.Vector3();
  camera.getWorldDirection(cameraForward);
  cameraForward.y = 0;
  cameraForward.normalize();
  const cameraRight = new THREE.Vector3(cameraForward.z, 0, -cameraForward.x);
  const desired = testPlayer.position.clone()
    .addScaledVector(cameraForward, (forward / length) * MOVE_SPEED * dt)
    .addScaledVector(cameraRight, (strafe / length) * MOVE_SPEED * dt);
  desired.y = 0;
  const blocked = collidesWithBoxes(desired);
  if (!blocked) testPlayer.position.copy(desired);
  ((testPlayer.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).color.set(blocked ? "#ff5e52" : "#f5f0df");
}

function collidesWithBoxes(position: THREE.Vector3): boolean {
  for (const box of boxes) {
    if (!box.solid) continue;
    const minX = box.position[0] - box.size[0] / 2 - PLAYER_RADIUS;
    const maxX = box.position[0] + box.size[0] / 2 + PLAYER_RADIUS;
    const minY = box.position[1] - box.size[1] / 2;
    const maxY = box.position[1] + box.size[1] / 2;
    const minZ = box.position[2] - box.size[2] / 2 - PLAYER_RADIUS;
    const maxZ = box.position[2] + box.size[2] / 2 + PLAYER_RADIUS;
    if (position.x >= minX && position.x <= maxX && PLAYER_HEIGHT >= minY && position.y <= maxY && position.z >= minZ && position.z <= maxZ) return true;
  }
  return false;
}

function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, 1 / 60);
  moveTestPlayer(dt);
  orbit.update();
  renderer.render(scene, camera);
}

function resize(): void {
  const width = Math.max(1, host.clientWidth);
  const height = Math.max(1, host.clientHeight);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

function boxToEditableInput(box: Omit<EditableBox, "mesh" | "edges"> | WorldBox): Omit<EditableBox, "mesh" | "edges"> {
  return {
    id: box.id,
    position: tuple(box.position, [0, 1, 0]),
    size: tuple(box.size, [2, 2, 2]),
    color: box.color,
    kind: box.kind,
    solid: box.solid
  };
}

function assetToExport(asset: THREE.Object3D): { name: string; position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] } {
  return {
    name: asset.name || "model",
    position: roundTuple([asset.position.x, asset.position.y, asset.position.z]),
    rotation: roundTuple([asset.rotation.x, asset.rotation.y, asset.rotation.z]),
    scale: roundTuple([asset.scale.x, asset.scale.y, asset.scale.z])
  };
}

function uniqueId(base: string): string {
  const clean = base.replace(/[^a-z0-9-_]/gi, "-").toLowerCase() || "box";
  let id = clean;
  let suffix = 2;
  while (boxes.some((box) => box.id === id)) id = `${clean}-${suffix++}`;
  return id;
}

function tuple(value: readonly unknown[] | undefined, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value)) return fallback;
  return [Number(value[0] ?? fallback[0]), Number(value[1] ?? fallback[1]), Number(value[2] ?? fallback[2])];
}

function roundTuple(value: [number, number, number]): [number, number, number] {
  return value.map((item) => Math.round(item * 100) / 100) as [number, number, number];
}

function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function numberInput(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!);
}
