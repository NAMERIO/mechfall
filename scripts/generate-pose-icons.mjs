import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";

const root = process.cwd();
const clientRoot = path.join(root, "client");
const outputPath = path.join(clientRoot, "public", "pose-icons.png");
const port = 4185;
const cellSize = 78;

const poseClips = {
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

const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
];

const executablePath = chromeCandidates.find((candidate) => existsSync(candidate));
if (!executablePath) throw new Error("Pose icon generation requires Chrome, Edge, or Chromium");

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><html><body></body></html>");
    return;
  }
  const filePath = pathname.startsWith("/node_modules/")
    ? path.join(clientRoot, pathname.slice(1))
    : path.join(clientRoot, "public", pathname === "/" ? "index.html" : pathname.slice(1));
  if (!filePath.startsWith(clientRoot) || !existsSync(filePath)) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { "Content-Type": mimeType(filePath) });
  createReadStream(filePath).pipe(response);
});

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

let browser;
try {
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
  });
  const renderSize = 180;
  const page = await browser.newPage({ viewport: { width: renderSize, height: renderSize }, deviceScaleFactor: 1 });
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) browserErrors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.setContent(renderPage(poseClips, cellSize, renderSize), { waitUntil: "load" });
  try {
    await page.waitForFunction(() => window.__poseSpriteReady === true, undefined, { timeout: 60_000 });
  } catch (error) {
    throw new Error(`${error.message}\nBrowser errors:\n${browserErrors.join("\n")}`);
  }
  if (browserErrors.length) throw new Error(`Browser errors:\n${browserErrors.join("\n")}`);
  const dataUrl = await page.evaluate(() => window.__poseSprite);
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(base64, "base64"));
  console.log(`Wrote ${outputPath}`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

function renderPage(clips, size, renderSize) {
  return `<!doctype html>
<html>
<body style="margin:0;background:transparent">
<script type="importmap">
{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}
</script>
<script type="module">
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
const clips = ${JSON.stringify(clips)};
const size = ${size};
const renderSize = ${renderSize};
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setClearColor(0x000000, 0);
renderer.setSize(renderSize, renderSize, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x91a09c, 3.8));
const key = new THREE.DirectionalLight(0xffffff, 2.8);
key.position.set(3, 5, 6);
scene.add(key);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 40);
camera.position.set(0, 0.55, 8);
camera.lookAt(0, 0.75, 0);
const gltf = await new GLTFLoader().loadAsync("/models/chameleon-man-pro.glb");
const model = gltf.scene;
model.rotation.y = Math.PI;
model.traverse((child) => {
  child.frustumCulled = false;
  if (!child.isMesh) return;
  child.material = new THREE.MeshStandardMaterial({ color: "#f5f0df", roughness: 1, metalness: 0 });
});
scene.add(model);
const mixer = new THREE.AnimationMixer(model);
const sprite = document.createElement("canvas");
sprite.width = size * Object.keys(clips).length;
sprite.height = size;
const context = sprite.getContext("2d");
let index = 0;
for (const clipName of Object.values(clips)) {
  mixer.stopAllAction();
  const clip = gltf.animations.find((animation) => animation.name === clipName);
  if (clip) {
    const action = mixer.clipAction(clip);
    action.reset().play();
    mixer.setTime(0);
  }
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model, true);
  const center = bounds.getCenter(new THREE.Vector3());
  const boxSize = bounds.getSize(new THREE.Vector3());
  model.position.set(-center.x, -bounds.min.y + 0.04, -center.z);
  const fit = Math.max(boxSize.x, boxSize.y) * 0.74 || 1.4;
  camera.left = -fit;
  camera.right = fit;
  camera.top = fit;
  camera.bottom = -fit;
  camera.updateProjectionMatrix();
  renderer.clear();
  renderer.render(scene, camera);
  context.drawImage(renderer.domElement, 0, 0, renderSize, renderSize, index * size, 0, size, size);
  index += 1;
}
window.__poseSprite = sprite.toDataURL("image/png");
window.__poseSpriteReady = true;
</script>
</body>
</html>`;
}

function mimeType(filePath) {
  if (filePath.endsWith(".js")) return "text/javascript";
  if (filePath.endsWith(".wasm")) return "application/wasm";
  if (filePath.endsWith(".glb")) return "model/gltf-binary";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".css")) return "text/css";
  return "text/html";
}
