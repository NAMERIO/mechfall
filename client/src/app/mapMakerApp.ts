import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { ConvexGeometry } from "three/addons/geometries/ConvexGeometry.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import {
  GAME,
  WORLD_BORDER_COLOR,
  WORLD_BOXES,
  WORLD_FLOOR_COLOR,
  WORLD_FLOOR_VISIBLE,
  WORLD_HULLS,
  WORLD_MODELS,
  WORLD_NAME,
  WORLD_SIZE,
  SPAWN_POINTS,
  convexHull2D,
  worldHullHeightAt,
  type WorldBox,
  type WorldHull
} from "@mechfall/shared";

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
type ImportedAsset = {
  id: string;
  model: THREE.Group;
  file: File;
  meshes: THREE.Mesh[];
};
type PlayerPreviewRole = "hider" | "seeker";
type PlayerPreview = {
  id: string;
  role: PlayerPreviewRole;
  color: string;
  root: THREE.Group;
  meshes: THREE.Mesh[];
  material: THREE.MeshStandardMaterial;
};
type EditableHull = {
  id: string;
  localVertices: [number, number, number][];
  triangles: [number, number, number][];
  color: string;
  kind: "hull";
  solid: boolean;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  generatedFrom?: "model";
  optimizedFromModel?: boolean;
  initialPosition?: [number, number, number];
  linkedToModel?: boolean;
  linkedAssetId?: string;
};
type EditorSnapshot = {
  worldSize: number;
  floorColor: string;
  borderColor: string;
  boxes: Array<Omit<EditableBox, "mesh" | "edges">>;
  hulls: Array<{
    input: Omit<EditableHull, "mesh" | "edges">;
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
  }>;
  assets: Array<{
    asset: ImportedAsset;
    transform: { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] };
  }>;
  selectedType?: "box" | "hull" | "asset";
  selectedId?: string;
};
type ModelCollisionBuild = {
  localVertices: [number, number, number][];
  triangles: [number, number, number][];
  sourceTriangles: number;
  optimized: boolean;
};
type ModelCollisionResult = ModelCollisionBuild & { created: number };

const KIND_OPTIONS: BoxKind[] = ["wall", "crate", "table", "column", "planter"];
const PLAYER_RADIUS = 0.48;
const PLAYER_HEIGHT = 2.15;
const MOVE_SPEED = 6;
const TEST_FLY_SPEED = 5;
const SELECTED_MOVE_SPEED = 7;
const SELECTED_MOVE_FAST_MULTIPLIER = 3;
const SELECTED_MOVE_VERTICAL_SPEED = 4;
const DEFAULT_FLOOR_COLOR = WORLD_FLOOR_COLOR;
const DEFAULT_BORDER_COLOR = WORLD_BORDER_COLOR;
const FLOOR_SNAP_DISTANCE = 0.45;
const ASSET_SCALE_STEP = 0.1;
const MIN_ASSET_SCALE = 0.02;
const ROTATION_SNAP_DEGREES = 45;
const ROTATION_SNAP_RADIANS = THREE.MathUtils.degToRad(ROTATION_SNAP_DEGREES);
const BORDER_WALL_IDS = new Set(["north", "south", "west", "east"]);
const MODEL_COLLISION_COLOR = "#57b9a9";
const MIN_COLLISION_SIZE = 0.08;
const MAX_UNDO_STEPS = 50;
const MAX_MODEL_FILE_BYTES = 64 * 1024 * 1024;
const MAX_EXACT_COLLISION_TRIANGLES = 12_000;
const MAX_OPTIMIZED_COLLISION_TRIANGLES = 6_000;
const MAX_COLLISION_CLUSTER_PASSES = 8;
const MAP_MAKER_PIXEL_RATIO_CAP = 1.2;
const MAP_MAKER_IDLE_FRAME_INTERVAL = 1_000 / 30;
const PLAYER_PREVIEW_HEIGHT = 2.45;
const PLAYER_PREVIEW_STAND_CLIP = "ChameleonMan|Pose_Straight";

document.body.className = "mapmaker-page";
document.body.innerHTML = `
  <main class="mapmaker-shell">
    <aside class="mapmaker-panel mapmaker-left">
      <header>
        <span>MECHFALL TOOL</span>
        <h1>MAP MAKER</h1>
        <p>Build collision shapes, place models, test movement, export code.</p>
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
        <label>SCALE CLIP</label>
        <label class="mapmaker-check"><input id="mm-uniform-scale" type="checkbox" checked /> UNIFORM SCALE</label>
        <div class="mapmaker-scale-tools">
          <button data-mm-scale-step="-1" type="button">SMALLER</button>
          <button id="mm-scale-reset" type="button">RESET</button>
          <button data-mm-scale-step="1" type="button">BIGGER</button>
        </div>
        <small>Uniform scale keeps width, height, and depth equal so props do not stretch weird.</small>
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
        <button id="mm-model-smart" type="button">REBUILD MODEL COLLISION</button>
        <button id="mm-collision-edit" type="button">EDIT COLLISION: OFF</button>
        <button id="mm-clear-model-collision" type="button">REMOVE MODEL COLLISION</button>
        <small>Normal mode keeps the model and collision together. Detailed models use welded collision that preserves corners and does not bridge empty space.</small>
        <small id="mm-status">Tip: GLB works best. Zip support needs extracted model files for now.</small>
      </section>
      <section class="mapmaker-test">
        <button id="mm-test-toggle" type="button">TEST COLLISION: OFF</button>
        <small>Test on: WASD moves relative to the camera, E flies up, Q flies down. Red means collision is blocking only that direction.</small>
        <small>Test off: WASD and Q/E move the selected map item.</small>
      </section>
      <section class="mapmaker-player-tool">
        <label>PLAYER PREVIEWS</label>
        <div class="mapmaker-tools">
          <button id="mm-add-hider" type="button">ADD HIDER</button>
          <button id="mm-add-seeker" type="button">ADD SEEKER</button>
        </div>
        <div class="mapmaker-fields">
          <label>PAINT COLOR <input id="mm-player-color" type="color" value="#57b9a9" disabled /></label>
          <label>X <input id="mm-player-x" type="number" step="0.1" disabled /></label>
          <label>Y <input id="mm-player-y" type="number" step="0.1" disabled /></label>
          <label>Z <input id="mm-player-z" type="number" step="0.1" disabled /></label>
        </div>
        <button id="mm-delete-player" type="button" disabled>DELETE PLAYER PREVIEW</button>
        <small>Editor-only staging actors. Move them with the gizmo or WASD/Q/E; they are never exported with the map.</small>
      </section>
      <section class="mapmaker-publish">
        <label>MAP NAME <input id="mm-map-name" maxlength="60" value="${escapeHtml(WORLD_NAME)}" /></label>
        <button id="mm-add-to-game" type="button">ADD TO GAME</button>
        <small>Saves this as the active game map, including collision, colors, transforms, and the imported model file.</small>
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
        <b>Mouse</b> select models · <b>Edit Collision</b> exposes hitboxes · <b>Backspace</b> delete · <b>Ctrl+Z</b> undo
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
        <label>SCENE ITEMS & COLLISION PARTS</label>
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
const mapNameInput = element<HTMLInputElement>("#mm-map-name");
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
const scaleInputs = {
  uniform: element<HTMLInputElement>("#mm-uniform-scale")
};
const playerPreviewInputs = {
  color: element<HTMLInputElement>("#mm-player-color"),
  x: element<HTMLInputElement>("#mm-player-x"),
  y: element<HTMLInputElement>("#mm-player-y"),
  z: element<HTMLInputElement>("#mm-player-z"),
  remove: element<HTMLButtonElement>("#mm-delete-player")
};

const scene = new THREE.Scene();
scene.background = new THREE.Color("#10191e");

const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 180);
camera.position.set(20, 18, 24);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAP_MAKER_PIXEL_RATIO_CAP));
renderer.shadowMap.enabled = false;
host.append(renderer.domElement);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 1.5, 0);
orbit.enableDamping = true;

const transform = new TransformControls(camera, renderer.domElement);
let transformMode: TransformMode = "translate";
transform.setMode("translate");
transform.addEventListener("dragging-changed", (event) => {
  orbit.enabled = !event.value;
  if (event.value && !playerPreviewForRoot(selectedAsset)) checkpointUndo();
});
transform.addEventListener("objectChange", () => {
  if (selected) {
    if (transformMode === "translate") snapBoxToFloor(selected);
    if (transformMode === "scale") {
      selected.size = roundTuple([
        Math.max(MIN_COLLISION_SIZE, Math.abs(selected.mesh.scale.x)),
        Math.max(MIN_COLLISION_SIZE, Math.abs(selected.mesh.scale.y)),
        Math.max(MIN_COLLISION_SIZE, Math.abs(selected.mesh.scale.z))
      ]);
      selected.mesh.scale.set(...selected.size);
    }
    selected.position = roundTuple([selected.mesh.position.x, selected.mesh.position.y, selected.mesh.position.z]);
    fillFields(selected);
    renderList();
    exportJson();
    return;
  }
  if (selectedHull) {
    if (transformMode === "translate") snapHullToFloor(selectedHull);
    fillFields(undefined, selectedHull);
    renderList();
    exportJson();
    return;
  }
  if (selectedAsset) {
    const playerPreview = playerPreviewForRoot(selectedAsset);
    if (playerPreview) {
      if (transformMode === "translate") snapAssetToFloor(selectedAsset);
      if (transformMode === "rotate" && !isIgnoringFloorSnap()) snapObjectRotation(selectedAsset);
      selectedTitle.textContent = `${playerPreview.role.toUpperCase()}: ${playerPreview.id}`;
      fillPlayerPreviewFields(playerPreview);
      renderList();
      return;
    }
    if (transformMode === "translate") snapAssetToFloor(selectedAsset);
    if (transformMode === "rotate" && !isIgnoringFloorSnap()) snapObjectRotation(selectedAsset);
    if (transformMode === "scale") applyUniformAssetScale(selectedAsset);
    selectedTitle.textContent = `ASSET: ${selectedAsset.name || "MODEL"}`;
    exportJson();
  }
});
scene.add(transform.getHelper());

scene.add(new THREE.HemisphereLight("#fff3d2", "#41515a", 2.2));
const sun = new THREE.DirectionalLight("#fff4cf", 3.2);
sun.position.set(-12, 24, 18);
sun.castShadow = false;
scene.add(sun);

let worldSize = WORLD_SIZE;
let floorColor = DEFAULT_FLOOR_COLOR;
let borderColor = DEFAULT_BORDER_COLOR;

const floor = new THREE.Mesh(new THREE.PlaneGeometry(worldSize, worldSize), new THREE.MeshStandardMaterial({ color: floorColor, roughness: 0.92 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = false;
floor.visible = WORLD_FLOOR_VISIBLE;
scene.add(floor);

let grid = makeGrid(worldSize);
grid.visible = WORLD_FLOOR_VISIBLE;
scene.add(grid);

let boxes: EditableBox[] = [];
let selected: EditableBox | undefined;
let hulls: EditableHull[] = [];
let selectedHull: EditableHull | undefined;
let selectedAsset: THREE.Group | undefined;
let importedAssets: ImportedAsset[] = [];
let playerPreviews: PlayerPreview[] = [];
let playerPreviewSequence = 0;
let playerPreviewTemplatePromise: Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> | undefined;
let testMode = false;
let collisionEditMode = false;
let restoringUndo = false;
let lastEditorRenderAt = 0;
const undoStack: EditorSnapshot[] = [];
const keys = new Set<string>();
const testPlayer = makeTestPlayer();
scene.add(testPlayer);

loadBoxes(WORLD_BOXES.map(boxToEditableInput));
for (const hull of WORLD_HULLS) addHull(worldHullToEditableInput(hull));
exportJson();
if (WORLD_MODELS.length) void loadActiveGameModels();

element<HTMLButtonElement>("#mm-add-box").addEventListener("click", () => {
  checkpointUndo();
  selectBox(addBox({ id: uniqueId("box"), position: [0, 1, 0], size: [2, 2, 2], color: "#d9564a", kind: "crate", solid: true }));
});
element<HTMLButtonElement>("#mm-duplicate-box").addEventListener("click", () => {
  if (selected) {
    checkpointUndo();
    selectBox(addBox({ ...boxToEditableInput(selected), id: uniqueId(`${selected.id}-copy`), position: [selected.position[0] + 1, selected.position[1], selected.position[2] + 1] }));
  } else if (selectedHull) {
    checkpointUndo();
    const copy = addHull({ ...hullToEditableInput(selectedHull), id: uniqueId(`${selectedHull.id}-copy`) });
    copy.mesh.position.copy(selectedHull.mesh.position).add(new THREE.Vector3(1, 0, 1));
    copy.mesh.rotation.copy(selectedHull.mesh.rotation);
    copy.mesh.scale.copy(selectedHull.mesh.scale);
    selectHull(copy);
    exportJson();
  }
});
element<HTMLButtonElement>("#mm-delete-box").addEventListener("click", deleteSelected);
element<HTMLButtonElement>("#mm-load-default").addEventListener("click", () => {
  checkpointUndo();
  resetDefaultMap();
});
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
scaleInputs.uniform.addEventListener("change", () => {
  if (!selectedAsset || playerPreviewForRoot(selectedAsset)) return;
  if (scaleInputs.uniform.checked) {
    checkpointUndo();
    applyUniformAssetScale(selectedAsset, true);
    exportJson();
  }
});
element<HTMLButtonElement>("#mm-scale-reset").addEventListener("click", resetSelectedAssetScale);
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mm-scale-step]")) {
  button.addEventListener("click", () => stepSelectedAssetScale(Number(button.dataset.mmScaleStep ?? 0)));
}
element<HTMLButtonElement>("#mm-apply-world").addEventListener("click", () => {
  checkpointUndo();
  applyWorldSettings();
});
element<HTMLButtonElement>("#mm-rebuild-border").addEventListener("click", () => {
  checkpointUndo();
  rebuildBorderWalls();
});
worldInputs.floorColor.addEventListener("input", applyWorldSettings);
worldInputs.size.addEventListener("change", applyWorldSettings);
worldInputs.borderColor.addEventListener("input", () => {
  borderColor = worldInputs.borderColor.value;
});
element<HTMLButtonElement>("#mm-model-smart").addEventListener("click", () => {
  checkpointUndo();
  rebuildSmartModelCollision(false);
});
element<HTMLButtonElement>("#mm-collision-edit").addEventListener("click", toggleCollisionEditMode);
element<HTMLButtonElement>("#mm-clear-model-collision").addEventListener("click", () => {
  checkpointUndo();
  clearModelCollision(true);
});
element<HTMLButtonElement>("#mm-test-toggle").addEventListener("click", () => {
  testMode = !testMode;
  element<HTMLButtonElement>("#mm-test-toggle").textContent = `TEST COLLISION: ${testMode ? "ON" : "OFF"}`;
  testPlayer.visible = testMode;
});
element<HTMLButtonElement>("#mm-add-hider").addEventListener("click", () => void spawnPlayerPreview("hider"));
element<HTMLButtonElement>("#mm-add-seeker").addEventListener("click", () => void spawnPlayerPreview("seeker"));
playerPreviewInputs.color.addEventListener("input", applyPlayerPreviewFields);
playerPreviewInputs.x.addEventListener("input", applyPlayerPreviewFields);
playerPreviewInputs.y.addEventListener("input", applyPlayerPreviewFields);
playerPreviewInputs.z.addEventListener("input", applyPlayerPreviewFields);
playerPreviewInputs.remove.addEventListener("click", deleteSelectedPlayerPreview);
element<HTMLButtonElement>("#mm-add-to-game").addEventListener("click", () => void addMapToGame());
element<HTMLInputElement>("#mm-model-file").addEventListener("change", (event) => {
  const input = event.currentTarget as HTMLInputElement;
  void importModel(input.files?.[0]).finally(() => {
    input.value = "";
  });
});
element<HTMLButtonElement>("#mm-export-json").addEventListener("click", exportJson);
element<HTMLButtonElement>("#mm-export-code").addEventListener("click", exportCode);
element<HTMLButtonElement>("#mm-copy-export").addEventListener("click", () => void navigator.clipboard.writeText(exportText.value));
element<HTMLButtonElement>("#mm-import-map").addEventListener("click", () => {
  checkpointUndo();
  importBoxesFromText();
});

for (const input of Object.values(inputs)) {
  input.addEventListener("focus", checkpointUndo);
  input.addEventListener("input", applyFieldsToSelected);
}
for (const input of Object.values(worldInputs)) input.addEventListener("focus", checkpointUndo);

renderer.domElement.addEventListener("pointerdown", (event) => {
  if ((transform as unknown as { dragging?: boolean }).dragging) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1));
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);
  const previewHit = raycaster.intersectObjects(playerPreviews.flatMap((preview) => preview.meshes), false)[0];
  if (previewHit) {
    const preview = playerPreviews.find((candidate) => candidate.meshes.includes(previewHit.object as THREE.Mesh));
    if (preview) selectAsset(preview.root);
    return;
  }
  if (collisionEditMode) {
    const hullHit = raycaster.intersectObjects(hulls.map((hull) => hull.mesh), false)[0];
    if (hullHit) {
      selectHull(hulls.find((hull) => hull.mesh === hullHit.object));
      return;
    }
    const boxHit = raycaster.intersectObjects(boxes.map((box) => box.mesh), false)[0];
    if (boxHit) {
      selectBox(boxes.find((box) => box.mesh === boxHit.object));
      return;
    }
  } else {
    const modelMeshes = importedAssets.flatMap((asset) => asset.meshes);
    const assetHit = raycaster.intersectObjects(modelMeshes, false)[0];
    if (assetHit) {
      const asset = importedAssets.find((candidate) => candidate.meshes.includes(assetHit.object as THREE.Mesh));
      if (asset) selectAsset(asset.model);
      return;
    }
    const boxHit = raycaster.intersectObjects(boxes.map((box) => box.mesh), false)[0];
    if (boxHit) {
      selectBox(boxes.find((box) => box.mesh === boxHit.object));
      return;
    }
  }
  selectBox(undefined);
});

window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.code === "KeyZ" && !event.shiftKey) {
    event.preventDefault();
    undoLastChange();
    return;
  }
  keys.add(event.code);
  if (!event.repeat && ["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE"].includes(event.code)
      && !isTypingInForm() && (selected || selectedHull || (selectedAsset && !playerPreviewForRoot(selectedAsset)))) checkpointUndo();
  if ((event.code === "Delete" || event.code === "Backspace") && !isTypingInForm()) {
    event.preventDefault();
    deleteSelected();
  }
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

function importedAssetForModel(model: THREE.Object3D | undefined): ImportedAsset | undefined {
  return model ? importedAssets.find((asset) => asset.model === model) : undefined;
}

function playerPreviewForRoot(root: THREE.Object3D | undefined): PlayerPreview | undefined {
  return root ? playerPreviews.find((preview) => preview.root === root) : undefined;
}

async function spawnPlayerPreview(role: PlayerPreviewRole): Promise<void> {
  const addButton = element<HTMLButtonElement>(role === "seeker" ? "#mm-add-seeker" : "#mm-add-hider");
  addButton.disabled = true;
  status.textContent = `Loading ${role} preview...`;
  try {
    playerPreviewTemplatePromise ??= new GLTFLoader().loadAsync("/models/chameleon-man-pro.glb?v=4")
      .then((gltf) => ({ scene: gltf.scene, animations: gltf.animations }));
    const template = await playerPreviewTemplatePromise;
    const visual = cloneSkeleton(template.scene);
    visual.rotation.y = Math.PI;
    const standingClip = template.animations.find((clip) => clip.name === PLAYER_PREVIEW_STAND_CLIP);
    if (standingClip) {
      const mixer = new THREE.AnimationMixer(visual);
      mixer.clipAction(standingClip).reset().play();
      mixer.update(0);
    }
    visual.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(visual, true);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const scale = size.y > 0 ? PLAYER_PREVIEW_HEIGHT / size.y : 1;
    visual.scale.setScalar(scale);
    visual.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);

    const color = role === "seeker" ? "#ff5d52" : "#57b9a9";
    const material = new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0 });
    const meshes: THREE.Mesh[] = [];
    visual.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.material = material;
      child.castShadow = false;
      child.receiveShadow = false;
      meshes.push(child);
    });
    if (meshes.length === 0) throw new Error("the character model contains no visible meshes");

    const root = new THREE.Group();
    const id = `${role}-${++playerPreviewSequence}`;
    root.name = id;
    root.add(visual);
    root.position.set(orbit.target.x, 0, orbit.target.z);
    if (role === "seeker") {
      root.scale.setScalar(GAME.hunterVisualScale);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.62, 0.055, 8, 24),
        new THREE.MeshBasicMaterial({ color: "#ff594f" })
      );
      ring.userData.isPlayerPreviewGeometry = true;
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 2.68;
      root.add(ring);
      meshes.push(ring);
    }
    const preview: PlayerPreview = { id, role, color, root, meshes, material };
    playerPreviews.push(preview);
    scene.add(root);
    selectAsset(root);
    status.textContent = `Added ${role} preview at the camera target. Move it with the gizmo or WASD/Q/E.`;
  } catch (error) {
    status.textContent = `Could not add ${role}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    addButton.disabled = false;
  }
}

function fillPlayerPreviewFields(preview: PlayerPreview | undefined): void {
  for (const input of [playerPreviewInputs.color, playerPreviewInputs.x, playerPreviewInputs.y, playerPreviewInputs.z]) {
    input.disabled = !preview;
  }
  playerPreviewInputs.remove.disabled = !preview;
  if (!preview) return;
  playerPreviewInputs.color.value = preview.color;
  playerPreviewInputs.x.value = formatNumber(preview.root.position.x);
  playerPreviewInputs.y.value = formatNumber(preview.root.position.y);
  playerPreviewInputs.z.value = formatNumber(preview.root.position.z);
}

function applyPlayerPreviewFields(): void {
  const preview = playerPreviewForRoot(selectedAsset);
  if (!preview) return;
  preview.color = playerPreviewInputs.color.value || preview.color;
  preview.material.color.set(preview.color);
  preview.root.position.set(
    numberInput(playerPreviewInputs.x, preview.root.position.x),
    numberInput(playerPreviewInputs.y, preview.root.position.y),
    numberInput(playerPreviewInputs.z, preview.root.position.z)
  );
  preview.root.updateMatrixWorld(true);
  selectedTitle.textContent = `${preview.role.toUpperCase()}: ${preview.id}`;
  renderList();
}

function deleteSelectedPlayerPreview(): void {
  const preview = playerPreviewForRoot(selectedAsset);
  if (preview) removePlayerPreview(preview);
}

function removePlayerPreview(preview: PlayerPreview): void {
  const wasSelected = selectedAsset === preview.root;
  if (wasSelected) {
    selectedAsset = undefined;
    transform.detach();
  }
  scene.remove(preview.root);
  const materials = new Set<THREE.Material>();
  preview.root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    if (child.userData.isPlayerPreviewGeometry) child.geometry.dispose();
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) materials.add(material);
  });
  for (const material of materials) material.dispose();
  playerPreviews = playerPreviews.filter((candidate) => candidate !== preview);
  if (wasSelected) {
    const next = playerPreviews.at(-1);
    if (next) selectAsset(next.root);
    else if (importedAssets[0]) selectAsset(importedAssets[0].model);
    else selectBox(undefined);
  } else {
    renderList();
  }
  status.textContent = `Removed ${preview.id}.`;
}

function linkedAssetForHull(hull: EditableHull | undefined): ImportedAsset | undefined {
  return hull?.linkedAssetId ? importedAssets.find((asset) => asset.id === hull.linkedAssetId) : undefined;
}

function checkpointUndo(): void {
  if (restoringUndo) return;
  undoStack.push(captureEditorSnapshot());
  if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
}

function captureEditorSnapshot(): EditorSnapshot {
  const selectedImportedAsset = importedAssetForModel(selectedAsset);
  const selectedType = selected ? "box" : selectedHull ? "hull" : selectedImportedAsset ? "asset" : undefined;
  return {
    worldSize,
    floorColor,
    borderColor,
    boxes: boxes.map((box) => boxToEditableInput(box)),
    hulls: hulls.map((hull) => ({
      input: hullToEditableInput(hull, true, false),
      position: roundTuple([hull.mesh.position.x, hull.mesh.position.y, hull.mesh.position.z]),
      rotation: roundTuple([hull.mesh.rotation.x, hull.mesh.rotation.y, hull.mesh.rotation.z]),
      scale: roundTuple([hull.mesh.scale.x, hull.mesh.scale.y, hull.mesh.scale.z])
    })),
    assets: importedAssets.map((asset) => ({ asset, transform: assetToExport(asset.model) })),
    selectedType,
    selectedId: selected?.id ?? selectedHull?.id ?? selectedImportedAsset?.id
  };
}

function undoLastChange(): void {
  const snapshot = undoStack.pop();
  if (!snapshot) {
    status.textContent = "Nothing to undo yet.";
    return;
  }
  restoringUndo = true;
  try {
    worldInputs.size.value = String(snapshot.worldSize);
    worldInputs.floorColor.value = snapshot.floorColor;
    worldInputs.borderColor.value = snapshot.borderColor;
    applyWorldSettings();
    for (const box of [...boxes]) removeEditableBox(box);
    for (const hull of [...hulls]) removeEditableHull(hull);
    for (const current of importedAssets) {
      if (!snapshot.assets.some(({ asset }) => asset === current)) scene.remove(current.model);
    }
    importedAssets = snapshot.assets.map(({ asset }) => asset);
    for (const { asset, transform: assetTransform } of snapshot.assets) {
      scene.add(asset.model);
      asset.model.position.set(...assetTransform.position);
      asset.model.rotation.set(...assetTransform.rotation);
      asset.model.scale.set(...assetTransform.scale);
      asset.model.updateMatrixWorld(true);
    }
    for (const input of snapshot.boxes) addBox(input);
    for (const hullSnapshot of snapshot.hulls) {
      const hull = addHull(hullSnapshot.input);
      hull.mesh.position.set(...hullSnapshot.position);
      hull.mesh.rotation.set(...hullSnapshot.rotation);
      hull.mesh.scale.set(...hullSnapshot.scale);
      hull.mesh.updateMatrixWorld(true);
    }
    if (snapshot.selectedType === "asset") selectAsset(importedAssets.find((asset) => asset.id === snapshot.selectedId)?.model);
    else if (snapshot.selectedType === "hull") selectHull(hulls.find((hull) => hull.id === snapshot.selectedId));
    else if (snapshot.selectedType === "box") selectBox(boxes.find((box) => box.id === snapshot.selectedId));
    else selectBox(undefined);
    exportJson();
    status.textContent = "Undid the last map maker change.";
  } finally {
    restoringUndo = false;
  }
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
  if (mode === "rotate" && selected) {
    mode = "translate";
    status.textContent = "Collision boxes are axis-aligned. Use MOVE or SCALE to adjust this part.";
  }
  if (mode === "scale" && selectedAsset && playerPreviewForRoot(selectedAsset)) {
    mode = "translate";
    status.textContent = "Player preview scale follows the real hider/seeker size. Use MOVE or ROTATE.";
  }
  transformMode = mode;
  transform.setMode(mode);
  if (mode === "scale" && selectedAsset) setUniformScaleReference(selectedAsset);
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
  grid.visible = WORLD_FLOOR_VISIBLE;
  scene.add(grid);
  exportJson();
}

function rebuildBorderWalls(): void {
  applyWorldSettings();
  for (const box of [...boxes]) {
    if (!BORDER_WALL_IDS.has(box.id)) continue;
    removeEditableBox(box);
  }

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
  loadHulls(WORLD_HULLS.map(worldHullToEditableInput));
  status.textContent = "Loaded the current game map.";
  void loadActiveGameModels();
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

function addHull(input: Omit<EditableHull, "mesh" | "edges">): EditableHull {
  const points = input.localVertices.map((vertex) => new THREE.Vector3(...vertex));
  const geometry = input.triangles.length > 0 ? new THREE.BufferGeometry() : new ConvexGeometry(points);
  if (input.triangles.length > 0) {
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(input.localVertices.flat(), 3));
    geometry.setIndex(input.triangles.flat());
    geometry.computeVertexNormals();
  }
  const material = new THREE.MeshStandardMaterial({
    color: input.color,
    transparent: true,
    opacity: input.solid ? 0.16 : 0.08,
    roughness: 0.7,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.isCollisionMesh = true;
  if (input.initialPosition) mesh.position.set(...input.initialPosition);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, 18),
    new THREE.LineBasicMaterial({ color: "#57b9a9", transparent: true, opacity: 0.9 })
  );
  mesh.add(edges);
  const hull: EditableHull = { ...input, mesh, edges };
  hulls.push(hull);
  const linkedAsset = input.linkedAssetId ? importedAssets.find((asset) => asset.id === input.linkedAssetId) : undefined;
  if (input.linkedToModel && linkedAsset) linkedAsset.model.add(mesh);
  else scene.add(mesh);
  syncHullMesh(hull);
  renderList();
  return hull;
}

function syncBoxMesh(box: EditableBox): void {
  box.mesh.name = box.id;
  box.mesh.position.set(...box.position);
  box.mesh.rotation.set(0, 0, 0);
  box.mesh.scale.set(...box.size);
  const material = box.mesh.material as THREE.MeshStandardMaterial;
  material.color.set(box.color);
  material.opacity = box.solid ? 0.42 : 0.18;
  (box.edges.material as THREE.LineBasicMaterial).color.set(selected === box ? "#f4d24f" : "#ff5e52");
  (box.edges.material as THREE.LineBasicMaterial).opacity = selected === box ? 1 : 0.85;
}

function syncHullMesh(hull: EditableHull): void {
  hull.mesh.name = hull.id;
  hull.mesh.visible = collisionEditMode;
  const material = hull.mesh.material as THREE.MeshStandardMaterial;
  material.color.set(hull.color);
  material.opacity = hull.solid ? 0.42 : 0.2;
  const edgeMaterial = hull.edges.material as THREE.LineBasicMaterial;
  edgeMaterial.color.set(selectedHull === hull ? "#f4d24f" : MODEL_COLLISION_COLOR);
  edgeMaterial.opacity = selectedHull === hull ? 1 : 0.78;
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

function getScalableTarget(): THREE.Object3D | undefined {
  return selectedAsset && !playerPreviewForRoot(selectedAsset) ? selectedAsset : undefined;
}

function stepSelectedAssetScale(direction: number): void {
  const target = getScalableTarget();
  if (!target) {
    status.textContent = "Select an imported asset first to scale it.";
    return;
  }
  const current = getUniformScaleValue(target);
  const multiplier = Math.max(MIN_ASSET_SCALE, 1 + direction * ASSET_SCALE_STEP);
  checkpointUndo();
  setUniformAssetScale(target, current * multiplier);
  status.textContent = `Scaled model and linked collision ${direction > 0 ? "bigger" : "smaller"}.`;
  exportJson();
}

function resetSelectedAssetScale(): void {
  const target = getScalableTarget();
  if (!target) {
    status.textContent = "Select an imported asset first to reset its scale.";
    return;
  }
  checkpointUndo();
  setUniformAssetScale(target, getDefaultUniformScale(target));
  status.textContent = "Reset model scale; linked collision followed it.";
  exportJson();
}

function applyUniformAssetScale(asset: THREE.Object3D, forceCurrent = false): void {
  if (!scaleInputs.uniform.checked) {
    setUniformScaleReference(asset);
    return;
  }
  const previous = getUniformScaleReference(asset);
  const current = [asset.scale.x, asset.scale.y, asset.scale.z];
  let next = forceCurrent ? getUniformScaleValue(asset) : current[0] ?? previous;
  if (!forceCurrent) {
    for (const value of current) {
      if (Math.abs(value - previous) > Math.abs(next - previous)) next = value;
    }
  }
  setUniformAssetScale(asset, next);
}

function setUniformAssetScale(asset: THREE.Object3D, value: number): void {
  const safeValue = Math.max(MIN_ASSET_SCALE, Math.abs(value));
  asset.scale.setScalar(safeValue);
  asset.userData.uniformScaleReference = safeValue;
  asset.updateMatrixWorld(true);
}

function setUniformScaleReference(asset: THREE.Object3D): void {
  asset.userData.uniformScaleReference = getUniformScaleValue(asset);
}

function getUniformScaleReference(asset: THREE.Object3D): number {
  return typeof asset.userData.uniformScaleReference === "number" ? asset.userData.uniformScaleReference : getUniformScaleValue(asset);
}

function getUniformScaleValue(asset: THREE.Object3D): number {
  return Math.max(MIN_ASSET_SCALE, (Math.abs(asset.scale.x) + Math.abs(asset.scale.y) + Math.abs(asset.scale.z)) / 3);
}

function getDefaultUniformScale(asset: THREE.Object3D): number {
  return typeof asset.userData.defaultUniformScale === "number" ? asset.userData.defaultUniformScale : 1;
}

function snapSelectedRotation(): void {
  const target = getRotatableTarget();
  if (!target) {
    status.textContent = "Select an imported asset first to snap its rotation.";
    return;
  }
  checkpointUndo();
  snapObjectRotation(target);
  setRotationClipBaseToCurrent(target);
  status.textContent = "Snapped model rotation; linked collision followed it.";
  exportJson();
}

function setSelectedYaw(degrees: number): void {
  const target = getRotatableTarget();
  if (!target) {
    status.textContent = "Select an imported asset first to set straight/side/diagonal.";
    return;
  }
  checkpointUndo();
  target.rotation.x = snapAngle(target.rotation.x);
  target.rotation.y = THREE.MathUtils.degToRad(degrees) - getVisualYawOffset(target);
  target.rotation.z = snapAngle(target.rotation.z);
  target.updateMatrixWorld(true);
  setRotationClipBaseToCurrent(target);
  status.textContent = `Set model yaw to ${degrees}°; linked collision followed it.`;
  exportJson();
}

function stepSelectedYaw(degrees: number): void {
  const target = getRotatableTarget();
  if (!target) {
    status.textContent = "Select an imported asset first to rotate it by 45°.";
    return;
  }
  checkpointUndo();
  target.rotation.y += THREE.MathUtils.degToRad(degrees);
  snapObjectRotation(target);
  setRotationClipBaseToCurrent(target);
  status.textContent = `Turned model ${degrees > 0 ? "+" : ""}${degrees}°; linked collision followed it.`;
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

function snapHullToFloor(hull: EditableHull): void {
  if (isIgnoringFloorSnap()) return;
  hull.mesh.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(hull.mesh);
  if (bounds.isEmpty() || Math.abs(bounds.min.y) > FLOOR_SNAP_DISTANCE) return;
  hull.mesh.position.y -= bounds.min.y;
  hull.mesh.updateMatrixWorld(true);
}

function selectBox(box: EditableBox | undefined): void {
  selected = box;
  selectedHull = undefined;
  selectedAsset = undefined;
  if (box && transformMode === "rotate") setTransformMode("translate");
  transform.detach();
  for (const item of boxes) syncBoxMesh(item);
  if (box) transform.attach(box.mesh);
  for (const hull of hulls) syncHullMesh(hull);
  fillFields(box, undefined);
  fillPlayerPreviewFields(undefined);
  renderList();
}

function selectHull(hull: EditableHull | undefined): void {
  if (hull?.linkedToModel && !collisionEditMode) {
    const linkedAsset = linkedAssetForHull(hull);
    if (linkedAsset) selectAsset(linkedAsset.model);
    return;
  }
  selected = undefined;
  selectedHull = hull;
  selectedAsset = undefined;
  transform.detach();
  for (const box of boxes) syncBoxMesh(box);
  for (const item of hulls) syncHullMesh(item);
  if (hull) transform.attach(hull.mesh);
  fillFields(undefined, hull);
  fillPlayerPreviewFields(undefined);
  renderList();
}

function toggleCollisionEditMode(): void {
  collisionEditMode = !collisionEditMode;
  const button = element<HTMLButtonElement>("#mm-collision-edit");
  button.textContent = `EDIT COLLISION: ${collisionEditMode ? "ON" : "OFF"}`;
  button.classList.toggle("active", collisionEditMode);
  for (const hull of hulls) syncHullMesh(hull);
  if (collisionEditMode) {
    const selectedAssetId = importedAssetForModel(selectedAsset)?.id;
    const linked = hulls.find((hull) => hull.linkedAssetId === selectedAssetId) ?? hulls.find((hull) => hull.linkedToModel);
    if (linked) selectHull(linked);
    status.textContent = "Collision-only editing is ON. Select the cyan triangle mesh to adjust or delete it.";
  } else {
    const linkedAsset = linkedAssetForHull(selectedHull);
    if (linkedAsset) selectAsset(linkedAsset.model);
    else if (importedAssets[0]) selectAsset(importedAssets[0].model);
    else if (selectedHull) selectHull(undefined);
    status.textContent = "Collision-only editing is OFF. The model and its collision now select and move as one item.";
  }
  renderList();
}

function selectAsset(asset: THREE.Group | undefined): void {
  selected = undefined;
  selectedHull = undefined;
  selectedAsset = asset;
  if (!asset) {
    transform.detach();
    fillFields(undefined, undefined);
    fillPlayerPreviewFields(undefined);
    renderList();
    return;
  }
  const playerPreview = playerPreviewForRoot(asset);
  if (playerPreview && transformMode === "scale") setTransformMode("translate");
  asset.userData.modelCollisionPosition ??= asset.position.clone();
  setUniformScaleReference(asset);
  transform.detach();
  for (const item of boxes) syncBoxMesh(item);
  transform.attach(asset);
  fillFields(undefined, undefined);
  fillPlayerPreviewFields(playerPreview);
  selectedTitle.textContent = playerPreview
    ? `${playerPreview.role.toUpperCase()}: ${playerPreview.id}`
    : `ASSET: ${asset.name || "MODEL"}`;
  status.textContent = playerPreview
    ? `${playerPreview.role === "seeker" ? "Seeker" : "Hider"} preview selected. Move it anywhere and choose its paint color.`
    : "Asset selected. It snaps to the floor when close. Hold Shift while dragging to ignore snap.";
  renderList();
}

function fillFields(box: EditableBox | undefined, hull: EditableHull | undefined = selectedHull): void {
  const item = box ?? hull;
  selectedTitle.textContent = item?.id ?? "NONE";
  for (const input of Object.values(inputs)) input.disabled = !item;
  if (!item) return;
  inputs.id.value = item.id;
  inputs.kind.value = item.kind === "hull" ? "crate" : item.kind;
  inputs.kind.disabled = item.kind === "hull";
  inputs.color.value = item.color;
  inputs.solid.checked = item.solid;
  if (box) {
    inputs.px.value = formatNumber(box.position[0]);
    inputs.py.value = formatNumber(box.position[1]);
    inputs.pz.value = formatNumber(box.position[2]);
    inputs.sx.value = formatNumber(box.size[0]);
    inputs.sy.value = formatNumber(box.size[1]);
    inputs.sz.value = formatNumber(box.size[2]);
    return;
  }
  const bounds = new THREE.Box3().setFromObject(hull!.mesh);
  const size = bounds.getSize(new THREE.Vector3());
  inputs.px.value = formatNumber(hull!.mesh.position.x);
  inputs.py.value = formatNumber(hull!.mesh.position.y);
  inputs.pz.value = formatNumber(hull!.mesh.position.z);
  inputs.sx.value = formatNumber(size.x);
  inputs.sy.value = formatNumber(size.y);
  inputs.sz.value = formatNumber(size.z);
}

function applyFieldsToSelected(): void {
  if (selectedHull) {
    selectedHull.id = inputs.id.value.trim() || selectedHull.id;
    selectedHull.color = inputs.color.value;
    selectedHull.solid = inputs.solid.checked;
    const bounds = new THREE.Box3().setFromObject(selectedHull.mesh);
    const currentSize = bounds.getSize(new THREE.Vector3());
    const desiredSize = new THREE.Vector3(
      Math.max(MIN_COLLISION_SIZE, numberInput(inputs.sx, currentSize.x)),
      Math.max(MIN_COLLISION_SIZE, numberInput(inputs.sy, currentSize.y)),
      Math.max(MIN_COLLISION_SIZE, numberInput(inputs.sz, currentSize.z))
    );
    selectedHull.mesh.position.set(
      numberInput(inputs.px, selectedHull.mesh.position.x),
      numberInput(inputs.py, selectedHull.mesh.position.y),
      numberInput(inputs.pz, selectedHull.mesh.position.z)
    );
    selectedHull.mesh.scale.multiply(new THREE.Vector3(
      desiredSize.x / Math.max(MIN_COLLISION_SIZE, currentSize.x),
      desiredSize.y / Math.max(MIN_COLLISION_SIZE, currentSize.y),
      desiredSize.z / Math.max(MIN_COLLISION_SIZE, currentSize.z)
    ));
    syncHullMesh(selectedHull);
    fillFields(undefined, selectedHull);
    renderList();
    exportJson();
    return;
  }
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
  for (const preview of playerPreviews) {
    const row = document.createElement("div");
    row.className = "mapmaker-box-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = selectedAsset === preview.root ? "active mapmaker-player-item" : "mapmaker-player-item";
    button.innerHTML = `<strong>${escapeHtml(preview.id)}</strong><span>${preview.role.toUpperCase()} PREVIEW Â· ${preview.color.toUpperCase()}</span>`;
    button.addEventListener("click", () => selectAsset(preview.root));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mapmaker-box-remove";
    remove.title = `Remove ${preview.id}`;
    remove.setAttribute("aria-label", `Remove ${preview.id}`);
    remove.textContent = "Ã—";
    remove.addEventListener("click", () => removePlayerPreview(preview));
    row.append(button, remove);
    boxList.append(row);
  }
  for (const asset of importedAssets) {
    const assetButton = document.createElement("button");
    assetButton.type = "button";
    assetButton.className = selectedAsset === asset.model ? "active mapmaker-asset-item" : "mapmaker-asset-item";
    assetButton.disabled = collisionEditMode;
    assetButton.innerHTML = `<strong>${escapeHtml(asset.model.name || "MODEL")}</strong><span>3D MODEL · ${collisionEditMode ? "DISABLE EDIT COLLISION TO SELECT" : "CLICK TO MOVE WITH COLLISION"}</span>`;
    assetButton.addEventListener("click", () => selectAsset(asset.model));
    boxList.append(assetButton);
  }
  for (const hull of hulls) {
    const row = document.createElement("div");
    row.className = "mapmaker-box-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = hull === selectedHull ? "active mapmaker-hull-item" : "mapmaker-hull-item";
    button.disabled = hull.linkedToModel === true && !collisionEditMode;
    const collisionLabel = hull.optimizedFromModel ? "WELDED DETAILED COLLISION" : "EXACT MODEL COLLISION";
    button.innerHTML = `<strong>${escapeHtml(hull.id)}</strong><span>${collisionLabel} · ${hull.triangles.length} TRIANGLES${button.disabled ? " · ENABLE EDIT COLLISION" : ""}</span>`;
    button.addEventListener("click", () => selectHull(hull));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mapmaker-box-remove";
    remove.disabled = hull.linkedToModel === true && !collisionEditMode;
    remove.title = `Remove ${hull.id}`;
    remove.setAttribute("aria-label", `Remove ${hull.id}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      checkpointUndo();
      removeEditableHull(hull);
      selectHull(hulls[0]);
      exportJson();
    });
    row.append(button, remove);
    boxList.append(row);
  }
  for (const box of boxes) {
    const row = document.createElement("div");
    row.className = "mapmaker-box-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = box === selected ? "active" : "";
    button.innerHTML = `<strong>${escapeHtml(box.id)}</strong><span>${box.kind} · ${box.size.map(formatNumber).join(" x ")}</span>`;
    button.addEventListener("click", () => selectBox(box));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mapmaker-box-remove";
    remove.title = `Remove ${box.id}`;
    remove.setAttribute("aria-label", `Remove ${box.id}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      checkpointUndo();
      const index = boxes.indexOf(box);
      const next = boxes[index + 1] ?? boxes[index - 1];
      removeEditableBox(box);
      selectBox(next);
      exportJson();
    });
    row.append(button, remove);
    boxList.append(row);
  }
}

function deleteSelected(): void {
  if (!selectedAsset && !selectedHull && !selected) return;
  const playerPreview = playerPreviewForRoot(selectedAsset);
  if (playerPreview) {
    removePlayerPreview(playerPreview);
    return;
  }
  checkpointUndo();
  if (selectedAsset) {
    const asset = importedAssetForModel(selectedAsset);
    if (asset) clearModelCollision(false, asset.id);
    scene.remove(selectedAsset);
    if (asset) importedAssets = importedAssets.filter((candidate) => candidate !== asset);
    selectedAsset = undefined;
    transform.detach();
    fillFields(undefined);
    renderList();
    status.textContent = "Deleted selected asset.";
    exportJson();
    return;
  }
  if (selectedHull) {
    const removed = selectedHull;
    const index = hulls.indexOf(removed);
    removeEditableHull(removed);
    selectHull(hulls[index] ?? hulls[index - 1]);
    exportJson();
    return;
  }
  if (!selected) return;
  const removed = selected;
  const index = boxes.indexOf(removed);
  removeEditableBox(removed);
  selectBox(boxes[index] ?? boxes[index - 1]);
  exportJson();
}

function removeEditableBox(box: EditableBox): void {
  if (selected === box) {
    selected = undefined;
    transform.detach();
  }
  scene.remove(box.mesh);
  box.edges.geometry.dispose();
  (box.edges.material as THREE.Material).dispose();
  box.mesh.geometry.dispose();
  (box.mesh.material as THREE.Material).dispose();
  boxes = boxes.filter((item) => item !== box);
}

function removeEditableHull(hull: EditableHull): void {
  if (selectedHull === hull) {
    selectedHull = undefined;
    transform.detach();
  }
  hull.mesh.removeFromParent();
  hull.edges.geometry.dispose();
  (hull.edges.material as THREE.Material).dispose();
  hull.mesh.geometry.dispose();
  (hull.mesh.material as THREE.Material).dispose();
  hulls = hulls.filter((item) => item !== hull);
}

function loadBoxes(inputs: Array<Omit<EditableBox, "mesh" | "edges">>): void {
  for (const box of [...boxes]) removeEditableBox(box);
  inputs.forEach((input) => addBox(input));
  selectBox(boxes[0]);
  exportJson();
}

function loadHulls(inputs: Array<Omit<EditableHull, "mesh" | "edges">>): void {
  for (const hull of [...hulls]) removeEditableHull(hull);
  for (const input of inputs) addHull(input);
  exportJson();
}

async function importModel(
  file: File | undefined,
  options: {
    id?: string;
    transform?: { position: readonly [number, number, number]; rotation: readonly [number, number, number]; scale: readonly [number, number, number] };
    loadingActive?: boolean;
    skipCollision?: boolean;
  } = {}
): Promise<ImportedAsset | undefined> {
  if (!file) return;
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".zip")) {
    status.textContent = "Zip import needs a zip parser. For now: extract the zip and import the .glb file.";
    return;
  }
  if (!lowerName.endsWith(".glb") && !lowerName.endsWith(".gltf")) {
    status.textContent = "Unsupported model file. Import a .glb file (recommended) or a self-contained .gltf file.";
    return;
  }
  if (file.size > MAX_MODEL_FILE_BYTES) {
    status.textContent = `Could not load ${file.name}: the file is larger than ${Math.round(MAX_MODEL_FILE_BYTES / 1024 / 1024)} MB. Optimize the model before importing it.`;
    return;
  }
  const url = URL.createObjectURL(file);
  let candidate: THREE.Group | undefined;
  let asset: ImportedAsset | undefined;
  try {
    status.textContent = `Loading ${file.name}...`;
    if (!options.loadingActive) checkpointUndo();
    const gltf = await new GLTFLoader().loadAsync(url);
    candidate = normalizeImportedModel(gltf.scene, file.name);
    asset = {
      id: options.id ?? uniqueAssetId(file.name.replace(/\.[^.]+$/, "")),
      model: candidate,
      file,
      meshes: getModelMeshes(candidate)
    };
    importedAssets.push(asset);
    scene.add(candidate);
    if (options.transform) {
      candidate.position.set(...options.transform.position);
      candidate.rotation.set(...options.transform.rotation);
      candidate.scale.set(...options.transform.scale);
      candidate.updateMatrixWorld(true);
    } else {
      snapAssetToFloor(candidate);
    }
    selectAsset(candidate);
    if (options.skipCollision) {
      status.textContent = `Loaded ${file.name} with its authored map collision.`;
      return asset;
    }
    const result = rebuildSmartModelCollision(true);
    if (!result?.created) throw new Error("the model does not contain usable triangle geometry");
    status.textContent = result.optimized
      ? `Loaded ${file.name}. Its ${result.sourceTriangles.toLocaleString()} visual triangles were reduced to one welded detailed ${result.triangles.length.toLocaleString()}-triangle collision mesh without convex bridge faces.`
      : `Loaded ${file.name} with one exact ${result.triangles.length.toLocaleString()}-triangle collision mesh.`;
    return asset;
  } catch (error) {
    if (candidate && asset) {
      clearModelCollision(false, asset.id);
      scene.remove(candidate);
      disposeObject(candidate);
      importedAssets = importedAssets.filter((item) => item !== asset);
      selectedAsset = undefined;
      transform.detach();
      fillFields(undefined);
      renderList();
    }
    status.textContent = `Could not load model: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadActiveGameModels(): Promise<void> {
  for (const asset of importedAssets) {
    scene.remove(asset.model);
    disposeObject(asset.model);
  }
  importedAssets = [];
  selectedAsset = undefined;
  let loaded = 0;
  for (const worldModel of WORLD_MODELS) {
    try {
      status.textContent = `Loading active game model ${loaded + 1}/${WORLD_MODELS.length}...`;
      const response = await fetch(worldModel.url, { cache: "no-store" });
      if (!response.ok) throw new Error(`${worldModel.url} returned ${response.status}`);
      const blob = await response.blob();
      const fileName = worldModel.url.split("/").at(-1) || `${worldModel.id}.glb`;
      const asset = await importModel(new File([blob], fileName, { type: blob.type || "model/gltf-binary" }), {
        id: worldModel.id,
        transform: worldModel,
        loadingActive: true,
        skipCollision: true
      });
      if (asset) loaded += 1;
    } catch (error) {
      console.warn("Active map model failed to load.", error);
    }
  }
  if (importedAssets[0]) selectAsset(importedAssets[0].model);
  exportJson();
  status.textContent = loaded === WORLD_MODELS.length
    ? `Loaded active game map: ${WORLD_NAME} (${loaded} model${loaded === 1 ? "" : "s"}).`
    : `Loaded ${loaded}/${WORLD_MODELS.length} active map models.`;
}

function normalizeImportedModel(model: THREE.Group, name: string): THREE.Group {
  const root = new THREE.Group();
  root.name = name;
  root.add(model);
  root.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(root);
  if (bounds.isEmpty()) throw new Error("the model has no visible mesh geometry");
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  if (![size.x, size.y, size.z, center.x, center.y, center.z].every(Number.isFinite)) {
    throw new Error("the model contains invalid vertex positions");
  }
  const scale = Math.min(1, 30 / Math.max(size.x, size.y, size.z, 0.001));
  model.position.sub(center);
  root.scale.setScalar(scale);
  root.userData.defaultUniformScale = scale;
  root.userData.uniformScaleReference = scale;
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = false;
      child.receiveShadow = false;
    }
    if (child === root) return;
    child.updateMatrix();
    child.matrixAutoUpdate = false;
  });
  return root;
}

function getModelMeshes(model: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  model.traverse((child) => {
    if (child instanceof THREE.Mesh && !child.userData.isCollisionMesh) meshes.push(child);
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

function rebuildSmartModelCollision(automatic: boolean): ModelCollisionResult | undefined {
  const asset = importedAssetForModel(selectedAsset);
  if (!asset) {
    status.textContent = "Select an imported GLB model first.";
    return undefined;
  }
  asset.model.updateMatrixWorld(true);
  const collision = buildModelCollision(asset.model);
  clearModelCollision(false, asset.id);
  if (collision.localVertices.length < 3 || collision.triangles.length < 1) return { ...collision, created: 0 };
  const created = addHull({
    id: uniqueId("model-exact-collision"),
    localVertices: collision.localVertices,
    triangles: collision.triangles,
    color: MODEL_COLLISION_COLOR,
    kind: "hull",
    solid: true,
    generatedFrom: "model",
    optimizedFromModel: collision.optimized,
    linkedToModel: true,
    linkedAssetId: asset.id
  });
  created.mesh.updateMatrixWorld(true);
  if (collisionEditMode) selectHull(created);
  else selectAsset(asset.model);
  if (!automatic) {
    status.textContent = collision.optimized
      ? `Built one welded detailed ${collision.triangles.length.toLocaleString()}-triangle collider from ${collision.sourceTriangles.toLocaleString()} visual triangles without bridging empty space. Turn Edit Collision on to adjust it.`
      : `Copied the exact model mesh: ${collision.triangles.length.toLocaleString()} collision triangles. Turn Edit Collision on to adjust it separately.`;
  }
  exportJson();
  return { ...collision, created: 1 };
}

function clearModelCollision(showStatus: boolean, assetId = importedAssetForModel(selectedAsset)?.id ?? selectedHull?.linkedAssetId): void {
  if (!assetId) {
    if (showStatus) status.textContent = "Select a model or its collision mesh first.";
    return;
  }
  const generatedHulls = hulls.filter((hull) => hull.generatedFrom === "model" && hull.linkedAssetId === assetId);
  const selectedWasGenerated = selectedHull ? generatedHulls.includes(selectedHull) : false;
  for (const hull of generatedHulls) removeEditableHull(hull);
  if (selectedWasGenerated) selectHull(undefined);
  else renderList();
  const removed = generatedHulls.length;
  if (showStatus) status.textContent = `Removed ${removed} generated model collision shape${removed === 1 ? "" : "s"}.`;
  exportJson();
}

function buildModelCollision(model: THREE.Group): ModelCollisionBuild {
  const meshes = getModelMeshes(model).filter((mesh) => mesh.visible && Boolean(mesh.geometry.getAttribute("position")));
  const sourceTriangles = meshes.reduce((total, mesh) => {
    const positions = mesh.geometry.getAttribute("position");
    return total + Math.floor((mesh.geometry.index?.count ?? positions?.count ?? 0) / 3);
  }, 0);
  if (sourceTriangles < 1) return { localVertices: [], triangles: [], sourceTriangles: 0, optimized: false };
  if (sourceTriangles <= MAX_EXACT_COLLISION_TRIANGLES) {
    return { ...buildExactModelCollision(model, meshes), sourceTriangles, optimized: false };
  }
  return { ...buildWeldedModelCollision(model, meshes), sourceTriangles, optimized: true };
}

function buildExactModelCollision(model: THREE.Group, meshes = getModelMeshes(model)): Pick<ModelCollisionBuild, "localVertices" | "triangles"> {
  model.updateMatrixWorld(true);
  const inverseRoot = model.matrixWorld.clone().invert();
  const vertices: [number, number, number][] = [];
  const triangles: [number, number, number][] = [];
  const vertexMap = new Map<string, number>();
  const point = new THREE.Vector3();

  for (const mesh of meshes) {
    if (mesh.userData.isCollisionMesh || !mesh.visible) continue;
    const positions = mesh.geometry.getAttribute("position");
    if (!positions) continue;
    const index = mesh.geometry.index;
    const faceCount = Math.floor((index?.count ?? positions.count) / 3);
    const toRoot = inverseRoot.clone().multiply(mesh.matrixWorld);
    for (let face = 0; face < faceCount; face += 1) {
      const triangle: number[] = [];
      for (let corner = 0; corner < 3; corner += 1) {
        const vertexIndex = index ? index.getX(face * 3 + corner) : face * 3 + corner;
        mesh.getVertexPosition(vertexIndex, point);
        point.applyMatrix4(toRoot);
        const key = `${point.x.toFixed(5)},${point.y.toFixed(5)},${point.z.toFixed(5)}`;
        let mergedIndex = vertexMap.get(key);
        if (mergedIndex === undefined) {
          mergedIndex = vertices.length;
          vertexMap.set(key, mergedIndex);
          vertices.push([point.x, point.y, point.z]);
        }
        triangle.push(mergedIndex);
      }
      if (triangle[0] !== triangle[1] && triangle[1] !== triangle[2] && triangle[0] !== triangle[2]) {
        triangles.push(triangle as [number, number, number]);
      }
    }
  }
  return { localVertices: vertices, triangles };
}

function buildWeldedModelCollision(
  model: THREE.Group,
  meshes: THREE.Mesh[]
): Pick<ModelCollisionBuild, "localVertices" | "triangles"> {
  model.updateMatrixWorld(true);
  const inverseRoot = model.matrixWorld.clone().invert();
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  for (const mesh of meshes) {
    const positions = mesh.geometry.getAttribute("position");
    if (!positions?.count) continue;
    const toRoot = inverseRoot.clone().multiply(mesh.matrixWorld);
    for (let index = 0; index < positions.count; index += 1) {
      mesh.getVertexPosition(index, point);
      point.applyMatrix4(toRoot);
      if (![point.x, point.y, point.z].every(Number.isFinite)) continue;
      bounds.expandByPoint(point);
    }
  }
  if (bounds.isEmpty()) throw new Error("the model does not have enough valid points for collision");

  const size = bounds.getSize(new THREE.Vector3());
  const largestDimension = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(largestDimension) || largestDimension <= Number.EPSILON) {
    throw new Error("the model geometry is flat or invalid and a collision mesh could not be generated");
  }

  // Surface meshes scale approximately with resolution squared. Start near
  // the desired triangle budget, then increase welding only when necessary.
  let weldDistance = largestDimension / Math.max(48, Math.sqrt(MAX_OPTIMIZED_COLLISION_TRIANGLES * 2));
  let result = buildClusteredModelCollision(model, meshes, inverseRoot, weldDistance);
  for (let pass = 1;
    pass < MAX_COLLISION_CLUSTER_PASSES && result.triangles.length > MAX_OPTIMIZED_COLLISION_TRIANGLES;
    pass += 1) {
    const reduction = Math.sqrt(result.triangles.length / MAX_OPTIMIZED_COLLISION_TRIANGLES);
    weldDistance *= THREE.MathUtils.clamp(reduction * 1.08, 1.15, 2.5);
    result = buildClusteredModelCollision(model, meshes, inverseRoot, weldDistance);
  }
  return result;
}

function buildClusteredModelCollision(
  model: THREE.Group,
  meshes: THREE.Mesh[],
  inverseRoot: THREE.Matrix4,
  weldDistance: number
): Pick<ModelCollisionBuild, "localVertices" | "triangles"> {
  model.updateMatrixWorld(true);
  const localVertices: [number, number, number][] = [];
  const triangles: [number, number, number][] = [];
  const vertexMap = new Map<string, number>();
  const triangleKeys = new Set<string>();
  const point = new THREE.Vector3();

  for (const mesh of meshes) {
    if (mesh.userData.isCollisionMesh || !mesh.visible) continue;
    const positions = mesh.geometry.getAttribute("position");
    if (!positions) continue;
    const index = mesh.geometry.index;
    const faceCount = Math.floor((index?.count ?? positions.count) / 3);
    const toRoot = inverseRoot.clone().multiply(mesh.matrixWorld);
    for (let face = 0; face < faceCount; face += 1) {
      const triangle: number[] = [];
      for (let corner = 0; corner < 3; corner += 1) {
        const vertexIndex = index ? index.getX(face * 3 + corner) : face * 3 + corner;
        mesh.getVertexPosition(vertexIndex, point);
        point.applyMatrix4(toRoot);
        if (![point.x, point.y, point.z].every(Number.isFinite)) continue;
        const gridX = Math.round(point.x / weldDistance);
        const gridY = Math.round(point.y / weldDistance);
        const gridZ = Math.round(point.z / weldDistance);
        const key = `${gridX},${gridY},${gridZ}`;
        let mergedIndex = vertexMap.get(key);
        if (mergedIndex === undefined) {
          mergedIndex = localVertices.length;
          vertexMap.set(key, mergedIndex);
          localVertices.push([point.x, point.y, point.z]);
        }
        triangle.push(mergedIndex);
      }
      if (triangle.length !== 3 || triangle[0] === triangle[1]
          || triangle[1] === triangle[2] || triangle[0] === triangle[2]) continue;
      const candidate = triangle as [number, number, number];
      if (collisionTriangleAreaSquared(localVertices, candidate) <= 1e-12) continue;
      const triangleKey = [...candidate].sort((a, b) => a - b).join(",");
      if (triangleKeys.has(triangleKey)) continue;
      triangleKeys.add(triangleKey);
      triangles.push(candidate);
    }
  }
  return compactCollisionMesh(localVertices, triangles);
}

function collisionTriangleAreaSquared(
  vertices: readonly (readonly [number, number, number])[],
  triangle: readonly [number, number, number]
): number {
  const a = vertices[triangle[0]]!;
  const b = vertices[triangle[1]]!;
  const c = vertices[triangle[2]]!;
  const abX = b[0] - a[0];
  const abY = b[1] - a[1];
  const abZ = b[2] - a[2];
  const acX = c[0] - a[0];
  const acY = c[1] - a[1];
  const acZ = c[2] - a[2];
  const crossX = abY * acZ - abZ * acY;
  const crossY = abZ * acX - abX * acZ;
  const crossZ = abX * acY - abY * acX;
  return crossX * crossX + crossY * crossY + crossZ * crossZ;
}

function compactCollisionMesh(
  vertices: [number, number, number][],
  triangles: [number, number, number][]
): Pick<ModelCollisionBuild, "localVertices" | "triangles"> {
  const used = new Map<number, number>();
  const localVertices: [number, number, number][] = [];
  const compactTriangles = triangles.map((triangle) => triangle.map((oldIndex) => {
    let newIndex = used.get(oldIndex);
    if (newIndex === undefined) {
      newIndex = localVertices.length;
      used.set(oldIndex, newIndex);
      localVertices.push(vertices[oldIndex]!);
    }
    return newIndex;
  }) as [number, number, number]);
  return { localVertices, triangles: compactTriangles };
}

function exportJson(): void {
  exportText.value = JSON.stringify({
    mapName: mapNameInput.value.trim() || WORLD_NAME,
    worldSize,
    floorColor,
    floorVisible: WORLD_FLOOR_VISIBLE,
    spawnPoints: SPAWN_POINTS,
    borderColor,
    assets: importedAssets.map((asset) => ({ id: asset.id, fileName: asset.file.name, ...assetToExport(asset.model) })),
    boxes: boxes.map(boxToEditableInput),
    hulls: hulls.map(hullToWorldHull)
  }, null, 2);
}

function exportCode(): void {
  const lines = boxes.map((box) => {
    const data = boxToEditableInput(box);
    return `  { id: ${JSON.stringify(data.id)}, position: [${data.position.join(", ")}], size: [${data.size.join(", ")}], color: ${JSON.stringify(data.color)}, kind: ${JSON.stringify(data.kind)}, solid: ${data.solid} },`;
  });
  const hullLines = hulls.map((hull) => {
    const data = hullToWorldHull(hull);
    return `  { id: ${JSON.stringify(data.id)}, vertices: ${JSON.stringify(data.vertices)}, triangles: ${JSON.stringify(data.triangles)}, color: ${JSON.stringify(data.color)}, kind: "hull", solid: ${data.solid} },`;
  });
  exportText.value = `export const WORLD_SIZE = ${formatNumber(worldSize)};\nexport const WORLD_WALL_THICKNESS = 1;\n// Map maker floor color: ${floorColor}\n\nexport const WORLD_BOXES: readonly WorldBox[] = [\n${lines.join("\n")}\n] as const;\n\nexport const WORLD_HULLS: readonly WorldHull[] = [\n${hullLines.join("\n")}\n] as const;`;
}

async function addMapToGame(): Promise<void> {
  const button = element<HTMLButtonElement>("#mm-add-to-game");
  const mapName = mapNameInput.value.trim();
  if (!mapName) {
    status.textContent = "Enter a map name before adding it to the game.";
    mapNameInput.focus();
    return;
  }
  button.disabled = true;
  button.textContent = "ADDING MAP...";
  status.textContent = `Adding ${mapName} to the game...`;
  try {
    const models: Array<{ id: string; url: string; transform: ReturnType<typeof assetToExport> }> = [];
    for (const asset of importedAssets) {
      const modelQuery = new URLSearchParams({ mapName, modelId: asset.id, fileName: asset.file.name });
      const modelResponse = await fetch(`/api/mapmaker/model?${modelQuery}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: asset.file
      });
      const modelResult = await modelResponse.json().catch(() => ({})) as { ok?: boolean; error?: string; url?: string };
      if (!modelResponse.ok || !modelResult.ok || !modelResult.url) {
        throw new Error(modelResult.error || `Model upload returned ${modelResponse.status}`);
      }
      models.push({ id: asset.id, url: modelResult.url, transform: assetToExport(asset.model) });
    }
    const response = await fetch("/api/mapmaker/add-to-game", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mapName,
        worldSize,
        floorColor,
        floorVisible: WORLD_FLOOR_VISIBLE,
        spawnPoints: SPAWN_POINTS,
        borderColor,
        boxes: boxes.map(boxToEditableInput),
        hulls: hulls.map(hullToWorldHull),
        models
      })
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; mapName?: string };
    if (!response.ok || !result.ok) throw new Error(result.error || `Server returned ${response.status}`);
    button.textContent = "ADDED TO GAME";
    status.textContent = `${result.mapName ?? mapName} is now the active game map. Reload the game; restart the dev server if an existing match still has the old physics.`;
    window.setTimeout(() => {
      button.textContent = "ADD TO GAME";
      button.disabled = false;
    }, 2200);
  } catch (error) {
    button.textContent = "ADD TO GAME";
    button.disabled = false;
    status.textContent = `Could not add map: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function importBoxesFromText(): void {
  try {
    const parsed = JSON.parse(element<HTMLTextAreaElement>("#mm-import-text").value) as unknown;
    const rawBoxes = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { boxes?: unknown }).boxes)
        ? (parsed as { boxes: unknown[] }).boxes
        : undefined;
    const rawHulls = parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray((parsed as { hulls?: unknown }).hulls)
      ? (parsed as { hulls: unknown[] }).hulls
      : [];
    if (!rawBoxes) throw new Error("Expected an array or { boxes: [...], hulls: [...] }");

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const payload = parsed as { mapName?: unknown; worldSize?: unknown; floorColor?: unknown; borderColor?: unknown };
      if (typeof payload.mapName === "string") mapNameInput.value = payload.mapName.slice(0, 60);
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
    loadHulls(rawHulls.map((rawHull, index) => worldHullToEditableInput(normalizeWorldHull(rawHull, index))));
    status.textContent = `Imported ${rawBoxes.length} collision boxes and ${rawHulls.length} triangle collision mesh${rawHulls.length === 1 ? "" : "es"}.`;
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
  const forwardInput = Number(keys.has("KeyW")) - Number(keys.has("KeyS"));
  const strafeInput = Number(keys.has("KeyD")) - Number(keys.has("KeyA"));
  const verticalInput = Number(keys.has("KeyE")) - Number(keys.has("KeyQ"));
  const planeLength = Math.hypot(forwardInput, strafeInput);
  const material = (testPlayer.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
  if (planeLength <= 0 && verticalInput === 0) {
    material.color.set("#f5f0df");
    return;
  }
  const cameraForward = new THREE.Vector3();
  camera.getWorldDirection(cameraForward);
  cameraForward.y = 0;
  if (cameraForward.lengthSq() <= 0.0001) cameraForward.set(0, 0, -1);
  cameraForward.normalize();
  const cameraRight = new THREE.Vector3(-cameraForward.z, 0, cameraForward.x);
  const movement = new THREE.Vector3();
  if (planeLength > 0) {
    movement
      .addScaledVector(cameraForward, (forwardInput / planeLength) * MOVE_SPEED * dt)
      .addScaledVector(cameraRight, (strafeInput / planeLength) * MOVE_SPEED * dt);
  }
  movement.y = verticalInput * TEST_FLY_SPEED * dt;

  const maximumStep = PLAYER_RADIUS * 0.35;
  const stepCount = Math.max(1, Math.ceil(movement.length() / maximumStep));
  const step = movement.multiplyScalar(1 / stepCount);
  let blocked = false;
  for (let index = 0; index < stepCount; index += 1) blocked = moveTestPlayerWithSlide(step) || blocked;
  material.color.set(blocked ? "#ff5e52" : "#f5f0df");
}

function moveTestPlayerWithSlide(step: THREE.Vector3): boolean {
  const fullMove = testPlayer.position.clone().add(step);
  const fullMoveHitsFloor = fullMove.y < 0;
  fullMove.y = Math.max(0, fullMove.y);
  if (!fullMoveHitsFloor && !collidesWithBoxes(fullMove)) {
    testPlayer.position.copy(fullMove);
    return false;
  }

  let blocked = fullMoveHitsFloor;
  for (const axis of ["x", "z", "y"] as const) {
    if (Math.abs(step[axis]) <= 1e-9) continue;
    const candidate = testPlayer.position.clone();
    candidate[axis] += step[axis];
    if (axis === "y" && candidate.y < 0) {
      candidate.y = 0;
      blocked = true;
      if (candidate.equals(testPlayer.position)) continue;
    }
    candidate.y = Math.max(0, candidate.y);
    if (collidesWithBoxes(candidate)) blocked = true;
    else testPlayer.position.copy(candidate);
  }
  return blocked;
}

function moveSelectedItem(dt: number): void {
  if (testMode || (transform as unknown as { dragging?: boolean }).dragging) return;
  if (isTypingInForm()) return;
  const target = selected?.mesh ?? selectedHull?.mesh ?? selectedAsset;
  if (!target) return;

  const forwardInput = Number(keys.has("KeyW")) - Number(keys.has("KeyS"));
  const strafeInput = Number(keys.has("KeyD")) - Number(keys.has("KeyA"));
  const verticalInput = Number(keys.has("KeyE")) - Number(keys.has("KeyQ"));
  const planeLength = Math.hypot(forwardInput, strafeInput);
  if (planeLength <= 0 && verticalInput === 0) return;

  const cameraForward = new THREE.Vector3();
  camera.getWorldDirection(cameraForward);
  cameraForward.y = 0;
  if (cameraForward.lengthSq() <= 0.0001) cameraForward.set(0, 0, -1);
  cameraForward.normalize();
  const cameraRight = new THREE.Vector3(-cameraForward.z, 0, cameraForward.x);
  const speed = SELECTED_MOVE_SPEED * (isIgnoringFloorSnap() ? SELECTED_MOVE_FAST_MULTIPLIER : 1);

  if (planeLength > 0) {
    target.position
      .addScaledVector(cameraForward, (forwardInput / planeLength) * speed * dt)
      .addScaledVector(cameraRight, (strafeInput / planeLength) * speed * dt);
  }
  if (verticalInput !== 0) target.position.y += verticalInput * SELECTED_MOVE_VERTICAL_SPEED * dt;

  if (selected) {
    if (transformMode === "translate") snapBoxToFloor(selected);
    selected.position = roundTuple([selected.mesh.position.x, selected.mesh.position.y, selected.mesh.position.z]);
    fillFields(selected);
    renderList();
  } else if (selectedHull) {
    if (transformMode === "translate") snapHullToFloor(selectedHull);
    fillFields(undefined, selectedHull);
    renderList();
  } else if (selectedAsset) {
    if (transformMode === "translate") snapAssetToFloor(selectedAsset);
    const playerPreview = playerPreviewForRoot(selectedAsset);
    if (playerPreview) {
      selectedTitle.textContent = `${playerPreview.role.toUpperCase()}: ${playerPreview.id}`;
      fillPlayerPreviewFields(playerPreview);
      return;
    }
    selectedTitle.textContent = `ASSET: ${selectedAsset.name || "MODEL"}`;
  }
  exportJson();
}

function isTypingInForm(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement;
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
    if (position.x >= minX && position.x <= maxX && position.y + PLAYER_HEIGHT >= minY && position.y <= maxY && position.z >= minZ && position.z <= maxZ) return true;
  }
  for (const hull of hulls) {
    if (!hull.solid) continue;
    const worldHull = hullToWorldHull(hull);
    const vertices = worldHull.vertices;
    const minY = Math.min(...vertices.map((vertex) => vertex[1]));
    const maxY = Math.max(...vertices.map((vertex) => vertex[1]));
    if (position.y > maxY || position.y + PLAYER_HEIGHT < minY) continue;
    if (worldHull.triangles?.length) {
      const top = worldHullHeightAt(worldHull, position.x, position.z);
      if (top !== undefined && position.y <= top && position.y + PLAYER_HEIGHT >= minY) return true;
      for (const triangle of worldHull.triangles) {
        const a = vertices[triangle[0]];
        const b = vertices[triangle[1]];
        const c = vertices[triangle[2]];
        if (!a || !b || !c) continue;
        const triangleMinY = Math.min(a[1], b[1], c[1]);
        const triangleMaxY = Math.max(a[1], b[1], c[1]);
        if (position.y > triangleMaxY || position.y + PLAYER_HEIGHT < triangleMinY) continue;
        if (circleTouchesTriangle2D(position.x, position.z, PLAYER_RADIUS, a, b, c)) return true;
      }
      continue;
    }
    const footprint = convexHull2D(vertices.map((vertex) => [vertex[0], vertex[2]]));
    if (pointInsideExpandedPolygon(position.x, position.z, footprint, PLAYER_RADIUS)) return true;
  }
  return false;
}

function circleTouchesTriangle2D(
  x: number,
  z: number,
  radius: number,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number]
): boolean {
  const denominator = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
  if (Math.abs(denominator) > 1e-9) {
    const first = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / denominator;
    const second = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / denominator;
    if (first >= 0 && second >= 0 && first + second <= 1) return true;
  }
  const radiusSquared = radius * radius;
  return pointSegmentDistanceSquared2D(x, z, a[0], a[2], b[0], b[2]) <= radiusSquared
    || pointSegmentDistanceSquared2D(x, z, b[0], b[2], c[0], c[2]) <= radiusSquared
    || pointSegmentDistanceSquared2D(x, z, c[0], c[2], a[0], a[2]) <= radiusSquared;
}

function pointSegmentDistanceSquared2D(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const edgeX = bx - ax;
  const edgeZ = bz - az;
  const lengthSquared = edgeX * edgeX + edgeZ * edgeZ;
  const amount = lengthSquared > 0 ? THREE.MathUtils.clamp(((x - ax) * edgeX + (z - az) * edgeZ) / lengthSquared, 0, 1) : 0;
  const dx = x - (ax + edgeX * amount);
  const dz = z - (az + edgeZ * amount);
  return dx * dx + dz * dz;
}

function pointInsideExpandedPolygon(x: number, z: number, points: readonly (readonly [number, number])[], radius: number): boolean {
  if (points.length < 3) return false;
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]!;
    const end = points[(index + 1) % points.length]!;
    const edgeX = end[0] - start[0];
    const edgeZ = end[1] - start[1];
    const length = Math.hypot(edgeX, edgeZ);
    const normalX = edgeZ / length;
    const normalZ = -edgeX / length;
    if ((x - start[0]) * normalX + (z - start[1]) * normalZ > radius) return false;
  }
  return true;
}

function animate(now = performance.now()): void {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, 1 / 60);
  moveSelectedItem(dt);
  moveTestPlayer(dt);
  const orbitChanged = orbit.update();
  const activelyEditing = orbitChanged
    || keys.size > 0
    || testMode
    || Boolean((transform as unknown as { dragging?: boolean }).dragging);
  if (!activelyEditing && now - lastEditorRenderAt < MAP_MAKER_IDLE_FRAME_INTERVAL) return;
  renderer.render(scene, camera);
  lastEditorRenderAt = now;
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

function hullToEditableInput(
  hull: EditableHull,
  preserveLink = false,
  cloneGeometry = true
): Omit<EditableHull, "mesh" | "edges"> {
  return {
    id: hull.id,
    localVertices: cloneGeometry ? hull.localVertices.map((vertex) => [...vertex] as [number, number, number]) : hull.localVertices,
    triangles: cloneGeometry ? hull.triangles.map((triangle) => [...triangle] as [number, number, number]) : hull.triangles,
    color: hull.color,
    kind: "hull",
    solid: hull.solid,
    generatedFrom: preserveLink ? hull.generatedFrom : undefined,
    optimizedFromModel: preserveLink ? hull.optimizedFromModel : undefined,
    linkedToModel: preserveLink ? hull.linkedToModel : false,
    linkedAssetId: preserveLink ? hull.linkedAssetId : undefined
  };
}

function worldHullToEditableInput(hull: WorldHull): Omit<EditableHull, "mesh" | "edges"> {
  const points = hull.vertices.map((vertex) => new THREE.Vector3(...vertex));
  const center = new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3());
  return {
    id: hull.id,
    localVertices: points.map((point) => roundTuple([point.x - center.x, point.y - center.y, point.z - center.z])),
    triangles: hull.triangles?.map((triangle) => [...triangle] as [number, number, number]) ?? [],
    color: hull.color,
    kind: "hull",
    solid: hull.solid,
    generatedFrom: hull.visible === false ? "model" : undefined,
    linkedToModel: hull.visible === false,
    linkedAssetId: hull.modelId ?? (hull.visible === false ? WORLD_MODELS[0]?.id : undefined),
    initialPosition: roundTuple([center.x, center.y, center.z])
  };
}

function normalizeWorldHull(value: unknown, index: number): WorldHull {
  const raw = value as Partial<WorldHull>;
  const vertices = Array.isArray(raw.vertices)
    ? raw.vertices.map((vertex) => tuple(vertex, [0, 0, 0])).filter((vertex) => vertex.every(Number.isFinite))
    : [];
  if (vertices.length < 4) throw new Error(`Hull ${index + 1} needs at least four vertices`);
  const triangles = Array.isArray(raw.triangles)
    ? raw.triangles.map((triangle) => tuple(triangle, [0, 0, 0]).map(Math.trunc) as [number, number, number])
      .filter((triangle) => triangle.every((vertex) => vertex >= 0 && vertex < vertices.length))
    : undefined;
  return {
    id: String(raw.id ?? `hull-${index + 1}`),
    vertices,
    triangles,
    color: String(raw.color ?? MODEL_COLLISION_COLOR),
    kind: "hull",
    solid: raw.solid !== false,
    visible: raw.visible !== false,
    modelId: typeof raw.modelId === "string" ? raw.modelId : undefined
  };
}

function getHullWorldVertices(hull: EditableHull): [number, number, number][] {
  hull.mesh.updateMatrixWorld(true);
  return hull.localVertices.map((vertex) => {
    const point = new THREE.Vector3(...vertex).applyMatrix4(hull.mesh.matrixWorld);
    return roundTuple([point.x, point.y, point.z]);
  });
}

function hullToWorldHull(hull: EditableHull): WorldHull {
  return {
    id: hull.id,
    vertices: getHullWorldVertices(hull),
    triangles: hull.triangles.map((triangle) => [...triangle] as [number, number, number]),
    color: hull.color,
    kind: "hull",
    solid: hull.solid,
    visible: hull.generatedFrom === "model" ? false : undefined,
    modelId: hull.generatedFrom === "model" ? hull.linkedAssetId : undefined
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
  while (boxes.some((box) => box.id === id) || hulls.some((hull) => hull.id === id)) id = `${clean}-${suffix++}`;
  return id;
}

function uniqueAssetId(base: string): string {
  const clean = base.replace(/[^a-z0-9-_]/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "model";
  let id = clean;
  let suffix = 2;
  while (importedAssets.some((asset) => asset.id === id)) id = `${clean}-${suffix++}`;
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
