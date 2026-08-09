import { GAME, PLAYER_POSES, type GameEvent, type PaintStroke, type Pose, type ServerMessage, type ServerSnapshot } from "@mechfall/shared";
import { InputController } from "../game/InputController.ts";
import { WorldRenderer } from "../game/WorldRenderer.ts";
import { GameConnection } from "../net/GameConnection.ts";

const element = <T extends HTMLElement>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing UI element: ${selector}`);
  return found;
};

const game = element<HTMLDivElement>("#game");
const menu = element<HTMLElement>("#menu");
const loading = element<HTMLDivElement>("#loading");
const loadingStatus = element<HTMLSpanElement>("#loading-status");
const hud = element<HTMLDivElement>("#hud");
const playButton = element<HTMLButtonElement>("#play-button");
const serverLabel = element<HTMLElement>("#server-label");
const nameInput = element<HTMLInputElement>("#name-input");
const roomCode = element<HTMLElement>("#room-code");
const phaseLabel = element<HTMLElement>("#phase-label");
const timer = element<HTMLElement>("#timer");
const timerFill = element<HTMLElement>("#timer-fill");
const aliveCount = element<HTMLElement>("#alive-count");
const pingLabel = element<HTMLElement>("#ping");
const roleLabel = element<HTMLElement>("#role-label");
const roleIcon = element<HTMLElement>("#role-icon");
const roleTip = element<HTMLElement>("#role-tip");
const paintPanel = element<HTMLElement>("#paint-panel");
const paintSwatch = element<HTMLElement>("#paint-swatch");
const paintHex = element<HTMLElement>("#paint-hex");
const colorInput = element<HTMLInputElement>("#color-input");
const paintButton = element<HTMLButtonElement>("#paint-button");
const poseButton = element<HTMLButtonElement>("#pose-button");
const poseLabel = element<HTMLElement>("#pose-label");
const poseMenu = element<HTMLElement>("#pose-menu");
const closePoseMenuButton = element<HTMLButtonElement>("#close-pose-menu");
const whistleButton = element<HTMLButtonElement>("#whistle-button");
const lockHint = element<HTMLElement>("#lock-hint");
const actionHint = element<HTMLElement>("#action-hint");
const toast = element<HTMLElement>("#toast");
const eventFeed = element<HTMLElement>("#event-feed");
const phaseScreen = element<HTMLElement>("#phase-screen");
const phaseKicker = element<HTMLElement>("#phase-kicker");
const phaseTitle = element<HTMLElement>("#phase-title");
const phaseCopy = element<HTMLElement>("#phase-copy");
const results = element<HTMLElement>("#results");
const resultTitle = element<HTMLElement>("#result-title");
const resultCopy = element<HTMLElement>("#result-copy");
const score = element<HTMLElement>("#score");
const paintModeUi = element<HTMLElement>("#paint-mode-ui");
const brushCursor = element<HTMLElement>("#brush-cursor");
const brushSizeInput = element<HTMLInputElement>("#brush-size");
const eyedropperButton = element<HTMLButtonElement>("#eyedropper-button");
const clearPaintButton = element<HTMLButtonElement>("#clear-paint-button");
const donePaintButton = element<HTMLButtonElement>("#done-paint-button");

const world = new WorldRenderer(game);
const input = new InputController(world.canvas);
world.bindInput(input);

let connection: GameConnection | undefined;
let latestSnapshot: ServerSnapshot | undefined;
let previousPhase = "";
let phaseTimeout = 0;
let inputTimer = 0;
let toastTimeout = 0;
let paintMode = false;
let poseMenuOpen = false;
let painting = false;
let orbitingPaintCamera = false;
let paintColor = "#f5f0df";
let brushSize = 0.07;
let lastPaintPoint: { x: number; y: number } | undefined;
let pendingPaintStrokes: PaintStroke[] = [];
let paintFlushTimer = 0;
let lastLocalShotAt = 0;
let pointerX = window.innerWidth / 2;
let pointerY = window.innerHeight / 2;

nameInput.value = localStorage.getItem("mechfall-name") ?? `Drifter ${Math.floor(Math.random() * 90 + 10)}`;
setBrushSize(brushSize);

void updateServerStatus();
window.setInterval(() => void updateServerStatus(), 15_000);

playButton.addEventListener("click", () => void startGame());
colorInput.addEventListener("input", () => selectPaintColor(colorInput.value));
paintButton.addEventListener("click", togglePaintMode);
poseButton.addEventListener("click", togglePoseMenu);
closePoseMenuButton.addEventListener("click", togglePoseMenu);
for (const poseChoice of document.querySelectorAll<HTMLButtonElement>("[data-pose]")) {
  poseChoice.addEventListener("click", () => selectPose(poseChoice.dataset.pose as Pose));
}
whistleButton.addEventListener("click", whistle);
donePaintButton.addEventListener("click", togglePaintMode);
clearPaintButton.addEventListener("click", clearPaint);
eyedropperButton.addEventListener("click", samplePaintColor);
brushSizeInput.addEventListener("input", () => setBrushSize(Number(brushSizeInput.value) / 100));
for (const swatch of document.querySelectorAll<HTMLButtonElement>("[data-paint-color]")) {
  swatch.addEventListener("click", () => selectPaintColor(swatch.dataset.paintColor ?? paintColor));
}
input.onPose = cyclePose;
input.onTogglePoses = togglePoseMenu;
input.onWhistle = whistle;
input.onTogglePaint = togglePaintMode;
input.onEyedropper = samplePaintColor;
input.onAction = () => {
  const self = world.getSelf();
  if (!self?.alive) return;
  if (self.role === "hunter") {
    if (latestSnapshot?.round.phase !== "hunting") {
      showToast("SHOTGUN LOCKED UNTIL THE HUNT STARTS");
      return;
    }
    const now = performance.now();
    if (now - lastLocalShotAt < GAME.shotgunCooldownMs) return;
    lastLocalShotAt = now;
    connection?.send({ type: "shoot", ...input.aim() });
    world.flashShot();
    playShotSound();
  } else if (self.role === "hider") {
    showToast("PRESS F TO OPEN CHROMA STUDIO");
  }
};

world.canvas.addEventListener("pointermove", (event) => {
  pointerX = event.clientX;
  pointerY = event.clientY;
  brushCursor.style.left = `${pointerX}px`;
  brushCursor.style.top = `${pointerY}px`;
  if (paintMode && orbitingPaintCamera) world.orbitPaintCamera(event.movementX, event.movementY);
  if (paintMode && painting) paintLineTo(pointerX, pointerY);
});
world.canvas.addEventListener("pointerdown", (event) => {
  if (!paintMode) return;
  event.preventDefault();
  if (event.button === 2 || event.button === 1) {
    orbitingPaintCamera = true;
    return;
  }
  if (event.button === 0) {
    painting = true;
    lastPaintPoint = { x: event.clientX, y: event.clientY };
    paintLineTo(event.clientX, event.clientY);
  }
});
window.addEventListener("pointerup", () => {
  painting = false;
  lastPaintPoint = undefined;
  orbitingPaintCamera = false;
});
world.canvas.addEventListener("contextmenu", (event) => {
  if (paintMode) event.preventDefault();
});
world.canvas.addEventListener("wheel", (event) => {
  if (!paintMode) return;
  event.preventDefault();
  setBrushSize(brushSize + (event.deltaY > 0 ? -0.01 : 0.01));
}, { passive: false });

document.addEventListener("pointerlockchange", () => {
  lockHint.classList.toggle("hidden", paintMode || poseMenuOpen || document.pointerLockElement === world.canvas);
});

async function updateServerStatus(): Promise<void> {
  try {
    const response = await fetch("/api/status");
    if (!response.ok) throw new Error("offline");
    const status = await response.json() as { players: number };
    serverLabel.textContent = `${status.players} ONLINE · SERVER READY`;
    playButton.disabled = false;
  } catch {
    serverLabel.textContent = "SERVER OFFLINE · START PNPM DEV";
  }
}

async function startGame(): Promise<void> {
  playButton.disabled = true;
  const name = nameInput.value.trim() || "Drifter";
  localStorage.setItem("mechfall-name", name);
  menu.classList.add("hidden");
  loading.classList.remove("hidden");
  loadingStatus.textContent = "Finding the nearest open room…";

  connection?.close();
  connection = new GameConnection(handleMessage);
  try {
    const match = await connection.connect(name);
    roomCode.textContent = match.roomId;
    loadingStatus.textContent = `Room ${match.roomId} found. Syncing world…`;
  } catch (error) {
    loading.classList.add("hidden");
    menu.classList.remove("hidden");
    playButton.disabled = false;
    serverLabel.textContent = error instanceof Error ? error.message.toUpperCase() : "CONNECTION FAILED";
  }
}

function handleMessage(message: ServerMessage): void {
  if (message.type === "welcome") {
    roomCode.textContent = message.roomId;
    return;
  }
  if (message.type === "error") {
    showToast(message.message);
    if (message.code === "disconnected") window.setTimeout(() => window.location.reload(), 1_800);
    return;
  }
  if (message.type === "paintStroke") {
    if (message.playerId !== latestSnapshot?.selfId) world.applyPaintStroke(message.playerId, message.stroke);
    return;
  }
  if (message.type === "paintStrokes") {
    if (message.playerId !== latestSnapshot?.selfId) {
      for (const stroke of message.strokes) world.applyPaintStroke(message.playerId, stroke);
    }
    return;
  }
  if (message.type === "paintState") {
    world.applyPaintState(message.players);
    return;
  }
  if (message.type === "paintReset") {
    if (!message.playerId || message.playerId === latestSnapshot?.selfId) discardPendingPaint();
    world.resetPaint(message.playerId);
    return;
  }
  if (message.type !== "snapshot") return;

  if (!latestSnapshot) {
    loading.classList.add("hidden");
    hud.classList.remove("hidden");
    inputTimer = window.setInterval(() => connection?.send({ type: "input", input: input.snapshot() }), 1000 / 30);
  }
  latestSnapshot = message;
  world.applySnapshot(message);
  updateHud(message);
}

function updateHud(snapshot: ServerSnapshot): void {
  const self = snapshot.players.find((player) => player.id === snapshot.selfId);
  if (!self) return;
  const now = Date.now();
  const remaining = Math.max(0, snapshot.round.endsAt - now);
  const seconds = Math.ceil(remaining / 1_000);
  timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  phaseLabel.textContent = snapshot.round.phase === "hiding" ? "HIDE PHASE" : snapshot.round.phase === "hunting" ? "HUNT PHASE" : snapshot.round.phase.toUpperCase();
  const phaseDuration = snapshot.round.phase === "hiding" ? GAME.hidingSeconds : snapshot.round.phase === "hunting" ? GAME.huntingSeconds : snapshot.round.phase === "results" ? GAME.resultsSeconds : GAME.warmupSeconds;
  timerFill.style.width = `${Math.min(100, remaining / (phaseDuration * 10))}%`;
  const hiders = snapshot.players.filter((player) => player.role === "hider" && player.alive).length;
  aliveCount.textContent = `${hiders} HIDER${hiders === 1 ? "" : "S"}`;
  pingLabel.textContent = `${connection?.latency ?? 0} MS`;
  roomCode.textContent = snapshot.roomId;
  score.textContent = String(self.score).padStart(4, "0");

  const displayRole = self.role === "spectator" ? "SPECTATING" : self.role.toUpperCase();
  roleLabel.textContent = displayRole;
  roleIcon.textContent = self.role === "hunter" ? "⌖" : self.role === "hider" ? "◈" : "◎";
  roleTip.textContent = self.role === "hunter"
    ? "Keep targets centered and click to fire the shotgun"
    : self.role === "hider"
      ? "Press F and hand-paint your camouflage"
      : "You rejoin when the next round begins";
  paintPanel.classList.toggle("hidden", self.role !== "hider");
  actionHint.textContent = self.role === "hunter" ? "CLICK TO FIRE" : self.role === "hider" ? "PRESS F TO PAINT" : "SPECTATING";
  paintSwatch.style.backgroundColor = paintColor;
  paintHex.textContent = paintColor.toUpperCase();
  poseLabel.textContent = POSE_LABELS[self.pose];
  if (self.role !== "hider" && paintMode) setPaintMode(false);
  if (self.role !== "hider" && poseMenuOpen) setPoseMenu(false);

  if (snapshot.event) {
    if (snapshot.event.type === "shot") world.showShot(snapshot.event.hunterId, snapshot.event.origin, snapshot.event.end);
    showEvent(snapshot.event);
  }
  if (snapshot.round.phase !== previousPhase) {
    previousPhase = snapshot.round.phase;
    announcePhase(snapshot);
  }

  const hunterBlind = snapshot.round.phase === "hiding" && self.role === "hunter";
  phaseScreen.classList.toggle("hunter-blind", hunterBlind);
  if (hunterBlind) {
    window.clearTimeout(phaseTimeout);
    phaseScreen.classList.remove("hidden");
    phaseKicker.textContent = `ROUND ${snapshot.round.round} · RELEASE IN ${seconds}`;
    phaseTitle.textContent = "EYES CLOSED";
    phaseCopy.textContent = "The drifters are painting. Your movement is locked until the hunt begins.";
  }
}

function announcePhase(snapshot: ServerSnapshot): void {
  window.clearTimeout(phaseTimeout);
  results.classList.add("hidden");
  phaseScreen.classList.remove("hunter-blind");
  if (snapshot.round.phase === "results") {
    if (paintMode) setPaintMode(false);
    if (poseMenuOpen) setPoseMenu(false);
    phaseScreen.classList.add("hidden");
    results.classList.remove("hidden");
    const huntersWon = snapshot.round.winner === "hunters";
    resultTitle.textContent = huntersWon ? "HUNTERS CLEAR THE FLOOR" : "HIDERS SURVIVE";
    resultCopy.textContent = huntersWon ? "Every disguise cracked under pressure." : "The factory keeps its secrets.";
    playTone(huntersWon ? 190 : 660, 0.2);
    return;
  }

  const phaseMessages = {
    waiting: ["ROOM WARMUP", "STAND BY", "New drifters can still join this round."],
    hiding: [`ROUND ${snapshot.round.round}`, "PAINT & HIDE", "Sample a wall. Change your shape. Become scenery."],
    hunting: [`ROUND ${snapshot.round.round}`, "THE HUNT IS ON", "Move carefully. Look twice. Trust no object."]
  } as const;
  const copy = phaseMessages[snapshot.round.phase];
  phaseKicker.textContent = copy[0];
  phaseTitle.textContent = copy[1];
  phaseCopy.textContent = copy[2];
  phaseScreen.classList.remove("hidden");
  phaseTimeout = window.setTimeout(() => phaseScreen.classList.add("hidden"), snapshot.round.phase === "waiting" ? 1_500 : 2_100);
  playTone(snapshot.round.phase === "hunting" ? 220 : 440, 0.12);
}

function selectPaintColor(color: string): void {
  paintColor = color.toLowerCase();
  paintSwatch.style.backgroundColor = color;
  paintHex.textContent = color.toUpperCase();
  colorInput.value = color;
}

function togglePaintMode(): void {
  setPaintMode(!paintMode);
}

function setPaintMode(active: boolean): void {
  const self = world.getSelf();
  if (active && poseMenuOpen) setPoseMenu(false);
  paintMode = Boolean(active && self?.role === "hider" && self.alive);
  painting = false;
  lastPaintPoint = undefined;
  orbitingPaintCamera = false;
  input.setPaintMode(paintMode);
  world.setPaintView(paintMode);
  paintModeUi.classList.toggle("hidden", !paintMode);
  hud.classList.toggle("painting", paintMode);
  paintButton.classList.toggle("active", paintMode);
  brushCursor.classList.toggle("hidden", !paintMode);
  if (!paintMode && active) showToast("PAINTING IS ONLY AVAILABLE TO ACTIVE HIDERS");
  if (!paintMode && !active && !poseMenuOpen && document.pointerLockElement !== world.canvas) void world.canvas.requestPointerLock().catch(() => {});
}

function togglePoseMenu(): void {
  setPoseMenu(!poseMenuOpen);
}

function setPoseMenu(active: boolean): void {
  const self = world.getSelf();
  if (active && paintMode) setPaintMode(false);
  poseMenuOpen = Boolean(active && self?.role === "hider" && self.alive);
  input.setPaintMode(paintMode || poseMenuOpen);
  poseMenu.classList.toggle("hidden", !poseMenuOpen);
  poseButton.classList.toggle("active", poseMenuOpen);
  if (!poseMenuOpen && active) showToast("POSES ARE ONLY AVAILABLE TO ACTIVE HIDERS");
  if (!poseMenuOpen && !active && !paintMode && document.pointerLockElement !== world.canvas) void world.canvas.requestPointerLock().catch(() => {});
}

function selectPose(pose: Pose): void {
  const self = world.getSelf();
  if (self?.role !== "hider" || !self.alive || !PLAYER_POSES.includes(pose)) return;
  connection?.send({ type: "pose", pose });
  poseLabel.textContent = POSE_LABELS[pose];
  setPoseMenu(false);
  showToast(`POSE · ${POSE_LABELS[pose]}`);
}

function paintLineTo(clientX: number, clientY: number): void {
  const from = lastPaintPoint ?? { x: clientX, y: clientY };
  const distance = Math.hypot(clientX - from.x, clientY - from.y);
  const spacing = Math.max(4, 13 - brushSize * 45);
  const steps = Math.min(64, Math.max(1, Math.ceil(distance / spacing)));
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const x = from.x + (clientX - from.x) * progress;
    const y = from.y + (clientY - from.y) * progress;
    const stroke = world.paintAtScreen(x, y, paintColor, brushSize);
    if (stroke) pendingPaintStrokes.push(stroke);
  }
  lastPaintPoint = { x: clientX, y: clientY };
  schedulePaintFlush();
}

function schedulePaintFlush(): void {
  if (paintFlushTimer || pendingPaintStrokes.length === 0) return;
  paintFlushTimer = window.setTimeout(flushPaintStrokes, 30);
}

function flushPaintStrokes(): void {
  paintFlushTimer = 0;
  const strokes = pendingPaintStrokes.splice(0, 64);
  if (strokes.length > 0) connection?.send({ type: "paintStrokes", strokes });
  if (pendingPaintStrokes.length > 0) schedulePaintFlush();
}

function samplePaintColor(): void {
  if (!paintMode) return;
  const sampled = world.sampleScreenColor(pointerX, pointerY);
  if (!sampled) {
    showToast("POINT AT A FACTORY SURFACE TO SAMPLE IT");
    return;
  }
  selectPaintColor(sampled);
  showToast(`EYEDROPPER · ${sampled.toUpperCase()}`);
  playTone(560, 0.07);
}

function clearPaint(): void {
  const selfId = latestSnapshot?.selfId;
  if (!paintMode || !selfId) return;
  discardPendingPaint();
  world.resetPaint(selfId);
  connection?.send({ type: "clearPaint" });
  showToast("CANVAS CLEARED");
}

function discardPendingPaint(): void {
  window.clearTimeout(paintFlushTimer);
  paintFlushTimer = 0;
  pendingPaintStrokes = [];
  lastPaintPoint = undefined;
}

function setBrushSize(size: number): void {
  brushSize = Math.max(0.02, Math.min(0.18, size));
  brushSizeInput.value = String(Math.round(brushSize * 100));
  const cursorSize = Math.round(18 + brushSize * 240);
  brushCursor.style.width = `${cursorSize}px`;
  brushCursor.style.height = `${cursorSize}px`;
}

function cyclePose(): void {
  const self = world.getSelf();
  if (self?.role !== "hider" || !self.alive) return;
  const index = PLAYER_POSES.indexOf(self.pose);
  selectPose(PLAYER_POSES[(index + 1) % PLAYER_POSES.length] ?? "stand");
}

function whistle(): void {
  const self = world.getSelf();
  if (self?.role !== "hider" || !self.alive) return;
  connection?.send({ type: "whistle" });
  showToast("WHISTLE SENT · +15 IF READY");
  playTone(920, 0.13);
}

function showEvent(event: GameEvent): void {
  if (event.type === "shot" && !event.hider) return;
  const line = document.createElement("div");
  if (event.type === "shot") line.innerHTML = `<strong>${escapeHtml(event.hunter)}</strong><span>shot</span><b>${escapeHtml(event.hider ?? "")}</b>`;
  if (event.type === "whistle") line.innerHTML = `<strong>${escapeHtml(event.player)}</strong><span>whistled</span>`;
  if (event.type === "join") line.innerHTML = `<strong>${escapeHtml(event.player)}</strong><span>dropped in</span>`;
  if (event.type === "leave") line.innerHTML = `<strong>${escapeHtml(event.player)}</strong><span>left the floor</span>`;
  eventFeed.prepend(line);
  while (eventFeed.children.length > 4) eventFeed.lastElementChild?.remove();
  window.setTimeout(() => line.remove(), 5_000);
}

function playShotSound(): void {
  try {
    const context = new AudioContext();
    const duration = 0.13;
    const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) {
      const fade = 1 - index / samples.length;
      samples[index] = (Math.random() * 2 - 1) * fade * fade;
    }
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = buffer;
    filter.type = "lowpass";
    filter.frequency.value = 1_500;
    gain.gain.setValueAtTime(0.16, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + duration);
    source.connect(filter).connect(gain).connect(context.destination);
    source.start();
    source.addEventListener("ended", () => void context.close());
  } catch {
    // Audio is a non-essential enhancement.
  }
}

function showToast(message: string): void {
  window.clearTimeout(toastTimeout);
  toast.textContent = message;
  toast.classList.add("visible");
  toastTimeout = window.setTimeout(() => toast.classList.remove("visible"), 1_500);
}

function playTone(frequency: number, duration: number): void {
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(frequency, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.72, context.currentTime + duration);
    gain.gain.setValueAtTime(0.05, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + duration);
    oscillator.addEventListener("ended", () => void context.close());
  } catch {
    // Audio is a non-essential enhancement.
  }
}

function escapeHtml(value: string): string {
  const holder = document.createElement("div");
  holder.textContent = value;
  return holder.innerHTML;
}

window.addEventListener("beforeunload", () => {
  window.clearInterval(inputTimer);
  connection?.close();
});

const POSE_LABELS: Record<Pose, string> = {
  stand: "STAND",
  aPose: "A POSE",
  backBend: "BACK BEND",
  bridge: "BRIDGE",
  crossLegged: "CROSS LEGGED",
  crouchedFetal: "CROUCHED FETAL",
  curledUp: "CURLED UP",
  fetal: "FETAL",
  handOnHip: "HAND ON HIP",
  layDown: "LAY DOWN",
  handUp: "HAND UP",
  mermaid: "MERMAID",
  openWide: "OPEN WIDE",
  sideLying: "SIDE LYING",
  sit: "SIT",
  tPose: "T POSE",
  tree: "TREE",
  wideSquat: "WIDE SQUAT"
};
