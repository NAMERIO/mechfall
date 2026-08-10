import { GAME, MAX_PAINT_STROKES_PER_PACKET, PLAYER_POSES, type GameEvent, type OpenLobbySummary, type PaintStroke, type Pose, type ServerMessage, type ServerSnapshot } from "@mechfall/shared";
import { InputController } from "../game/InputController.ts";
import { WorldRenderer } from "../game/WorldRenderer.ts";
import { GameConnection, listOpenLobbies, type MatchIntent } from "../net/GameConnection.ts";

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
const lobbyCount = element<HTMLElement>("#lobby-count");
const lobbyStatus = element<HTMLElement>("#lobby-status");
const lobbyList = element<HTMLElement>("#lobby-list");
const refreshLobbiesButton = element<HTMLButtonElement>("#refresh-lobbies-button");
const leaveGameButton = element<HTMLButtonElement>("#leave-game-button");
const gameCode = element<HTMLElement>("#game-code");
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
const crosshair = element<HTMLElement>("#crosshair");
const actionHint = element<HTMLElement>("#action-hint");
const toast = element<HTMLElement>("#toast");
const eventFeed = element<HTMLElement>("#event-feed");
const phaseScreen = element<HTMLElement>("#phase-screen");
const phaseKicker = element<HTMLElement>("#phase-kicker");
const phaseTitle = element<HTMLElement>("#phase-title");
const phaseCopy = element<HTMLElement>("#phase-copy");
const startGameButton = element<HTMLButtonElement>("#start-game-button");
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
let connecting = false;
let serverOnline = false;
let lobbyFetchInFlight = false;
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
let queuedPaintPoint: { x: number; y: number } | undefined;
let paintFrameQueued = false;
let pendingPaintStrokes: PaintStroke[] = [];
let paintFlushTimer = 0;
let lastLocalShotAt = 0;
let pointerX = window.innerWidth / 2;
let pointerY = window.innerHeight / 2;

stripLegacyGameIdFromUrl();
nameInput.value = localStorage.getItem("mechfall-name") ?? `Drifter ${Math.floor(Math.random() * 90 + 10)}`;
setBrushSize(brushSize);

void refreshLobbies();
const lobbyPollTimer = window.setInterval(() => void refreshLobbies(), 5_000);

playButton.addEventListener("click", () => void startGame({ kind: "create" }));
nameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !playButton.disabled) void startGame({ kind: "create" });
});
refreshLobbiesButton.addEventListener("click", () => void refreshLobbies());
leaveGameButton.addEventListener("click", leaveGame);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshLobbies();
});
gameCode.closest(".room-chip")?.addEventListener("click", () => void copyGameId());
startGameButton.addEventListener("click", requestRoundStart);
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
  }
};

world.canvas.addEventListener("pointermove", (event) => {
  pointerX = event.clientX;
  pointerY = event.clientY;
  brushCursor.style.left = `${pointerX}px`;
  brushCursor.style.top = `${pointerY}px`;
  if (paintMode && orbitingPaintCamera) world.orbitPaintCamera(event.movementX, event.movementY);
  if (paintMode && painting) queuePaintLine(pointerX, pointerY);
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
  flushQueuedPaintLine();
  painting = false;
  lastPaintPoint = undefined;
  orbitingPaintCamera = false;
});
world.canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});
world.canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  if (paintMode) {
    setBrushSize(brushSize + (event.deltaY > 0 ? -0.01 : 0.01));
  } else {
    world.zoomCamera(event.deltaY);
  }
}, { passive: false });

async function refreshLobbies(): Promise<void> {
  if (lobbyFetchInFlight || connecting || menu.classList.contains("hidden") || document.visibilityState !== "visible") return;

  lobbyFetchInFlight = true;
  refreshLobbiesButton.setAttribute("aria-busy", "true");
  if (lobbyList.childElementCount === 0) setLobbyState("loading", "CHECKING FOR OPEN LOBBIES…");
  syncMenuControls();

  try {
    const lobbies = await listOpenLobbies();
    serverOnline = true;
    renderLobbies(lobbies);
    serverLabel.textContent = lobbies.length === 0
      ? "SERVER READY · CREATE THE FIRST"
      : `${lobbies.length} OPEN · SERVER READY`;
  } catch {
    serverOnline = false;
    lobbyCount.textContent = "OFFLINE";
    serverLabel.textContent = "SERVER OFFLINE · RETRY";
    setLobbyState("offline", "LOBBY DIRECTORY OFFLINE · RETRY IN A MOMENT");
  } finally {
    lobbyFetchInFlight = false;
    refreshLobbiesButton.removeAttribute("aria-busy");
    syncMenuControls();
  }
}

function renderLobbies(lobbies: OpenLobbySummary[]): void {
  lobbyList.replaceChildren();
  lobbyCount.textContent = `${lobbies.length} OPEN`;
  if (lobbies.length === 0) {
    setLobbyState("empty", "NO OPEN LOBBIES · CREATE THE FIRST ONE");
    return;
  }

  lobbyStatus.classList.add("hidden");
  lobbyList.classList.remove("hidden");
  for (const lobby of lobbies) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lobby-row";
    button.setAttribute("aria-label", `Join ${lobby.ownerName}'s lobby, game ${lobby.gameId}, ${lobby.playerCount} of ${lobby.maxPlayers} players`);

    const copy = document.createElement("span");
    copy.className = "lobby-row-copy";
    const owner = document.createElement("strong");
    owner.className = "lobby-row-owner";
    owner.textContent = `${lobby.ownerName}'s lobby`;
    const id = document.createElement("small");
    id.className = "lobby-row-id";
    id.textContent = `GAME ${lobby.gameId}`;
    copy.append(owner, id);

    const count = document.createElement("span");
    count.className = "lobby-row-count";
    const currentPlayers = document.createElement("b");
    currentPlayers.textContent = String(lobby.playerCount);
    count.append(currentPlayers, ` / ${lobby.maxPlayers}`);

    const arrow = document.createElement("span");
    arrow.className = "lobby-row-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "→";

    button.append(copy, count, arrow);
    button.addEventListener("click", () => void startGame({ kind: "join", gameId: lobby.gameId }));
    lobbyList.append(button);
  }
  syncMenuControls();
}

function setLobbyState(state: "loading" | "empty" | "offline", message: string): void {
  lobbyStatus.dataset.state = state;
  lobbyStatus.textContent = message;
  lobbyStatus.classList.remove("hidden");
  lobbyList.classList.add("hidden");
}

function syncMenuControls(): void {
  const actionsDisabled = connecting || !serverOnline;
  playButton.disabled = actionsDisabled;
  refreshLobbiesButton.disabled = connecting || lobbyFetchInFlight;
  for (const joinButton of lobbyList.querySelectorAll<HTMLButtonElement>(".lobby-row")) joinButton.disabled = actionsDisabled;
}

async function startGame(intent: MatchIntent): Promise<void> {
  if (connecting || !serverOnline) return;
  connecting = true;
  syncMenuControls();
  const name = nameInput.value.trim() || "Drifter";
  localStorage.setItem("mechfall-name", name);
  menu.classList.add("hidden");
  loading.classList.remove("hidden");
  loadingStatus.textContent = intent.kind === "create" ? "Creating your lobby…" : `Joining game ${intent.gameId}…`;

  connection?.close();
  connection = new GameConnection(handleMessage);
  try {
    const match = await connection.connect(name, intent);
    gameCode.textContent = match.gameId;
    loadingStatus.textContent = `Game ${match.gameId} found. Syncing world…`;
  } catch (error) {
    connection?.close();
    connection = undefined;
    connecting = false;
    loading.classList.add("hidden");
    menu.classList.remove("hidden");
    const message = error instanceof Error ? error.message.toUpperCase() : "CONNECTION FAILED";
    serverOnline = false;
    lobbyCount.textContent = "REFRESHING";
    serverLabel.textContent = message;
    setLobbyState("offline", message);
    syncMenuControls();
    window.setTimeout(() => void refreshLobbies(), 1_200);
  }
}

function handleMessage(message: ServerMessage): void {
  if (message.type === "welcome") {
    gameCode.textContent = message.gameId;
    return;
  }
  if (message.type === "error") {
    showToast(message.message);
    if (message.code === "disconnected") window.setTimeout(reloadCleanHome, 1_800);
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
  if (!self) {
    crosshair.classList.add("hidden");
    return;
  }
  const now = Date.now();
  const remaining = Math.max(0, snapshot.round.endsAt - now);
  const seconds = Math.ceil(remaining / 1_000);
  timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  phaseLabel.textContent = snapshot.round.phase === "hiding" ? "HIDE PHASE" : snapshot.round.phase === "hunting" ? "HUNT PHASE" : snapshot.round.phase.toUpperCase();
  const phaseDuration = snapshot.round.phase === "hiding" ? GAME.hidingSeconds : snapshot.round.phase === "hunting" ? GAME.huntingSeconds : snapshot.round.phase === "results" ? GAME.resultsSeconds : GAME.warmupSeconds;
  timerFill.style.width = `${Math.min(100, remaining / (phaseDuration * 10))}%`;
  const hiders = snapshot.players.filter((player) => player.role === "hider" && player.alive).length;
  aliveCount.textContent = snapshot.round.phase === "waiting"
    ? `${snapshot.players.length} PLAYER${snapshot.players.length === 1 ? "" : "S"}`
    : `${hiders} HIDER${hiders === 1 ? "" : "S"}`;
  pingLabel.textContent = `${connection?.latency ?? 0} MS`;
  gameCode.textContent = snapshot.gameId;
  score.textContent = String(self.score).padStart(4, "0");

  const isLobbyOwner = snapshot.round.phase === "waiting" && snapshot.ownerId === snapshot.selfId;
  const canShoot = self.alive && self.role === "hunter" && snapshot.round.phase === "hunting";
  crosshair.classList.toggle("hidden", !canShoot);
  const displayRole = isLobbyOwner ? "GAME OWNER" : snapshot.round.phase === "waiting" ? "PLAYER" : self.role === "spectator" ? "SPECTATING" : self.role.toUpperCase();
  roleLabel.textContent = displayRole;
  roleIcon.textContent = isLobbyOwner ? "★" : self.role === "hunter" ? "⌖" : self.role === "hider" ? "◈" : "◎";
  roleTip.textContent = self.cling
    ? "Attached · Press V to face camera · Hold LMB to center camera · Hold RMB to orbit · Space up · Shift down · A/D sideways · S/away to leave"
    : snapshot.round.phase === "waiting"
    ? isLobbyOwner ? "You control when the next round starts" : "The game owner controls the start"
    : self.role === "hunter"
    ? canShoot ? "Click LMB to fire · press V to face camera · hold LMB to center camera · hold RMB to orbit · wheel to zoom" : "Shotgun locked · press V to face camera · hold LMB to center camera · hold RMB to orbit"
    : self.role === "hider"
      ? "Press V to face camera · hold LMB to center camera · hold RMB to orbit · press F to paint · wheel to zoom"
      : "You rejoin when the next round begins";
  paintPanel.classList.toggle("hidden", self.role !== "hider");
  actionHint.textContent = self.cling
    ? "V FACE CAMERA · SPACE UP · SHIFT DOWN · A/D SIDEWAYS · S/AWAY RELEASE"
    : snapshot.round.phase === "waiting"
    ? isLobbyOwner ? "START WHEN EVERYONE IS READY" : "WAITING FOR GAME OWNER"
    : canShoot
      ? "LMB CLICK FIRE · V FACE CAMERA · LMB CENTER CAMERA · RMB HOLD ORBIT"
      : self.role === "hunter"
        ? "SHOTGUN LOCKED · V FACE CAMERA · LMB CENTER CAMERA · RMB HOLD ORBIT"
        : self.role === "hider"
          ? "V FACE CAMERA · LMB CENTER CAMERA · RMB HOLD ORBIT · F PAINT"
          : "SPECTATING · RMB HOLD ORBIT · WHEEL ZOOM";
  paintSwatch.style.backgroundColor = paintColor;
  paintHex.textContent = paintColor.toUpperCase();
  poseLabel.textContent = POSE_LABELS[self.pose];
  if (self.role !== "hider" && paintMode) setPaintMode(false);
  if (self.role !== "hider" && poseMenuOpen) setPoseMenu(false);

  if (snapshot.event) {
    if (snapshot.event.type === "shot") world.showShot(snapshot.event.hunterId, snapshot.event.origin, snapshot.event.end);
    showEvent(snapshot.event);
  }
  updateLobby(snapshot);
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
  phaseScreen.classList.toggle("lobby", snapshot.round.phase === "waiting");
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

  if (snapshot.round.phase === "waiting") {
    phaseScreen.classList.remove("hidden");
    updateLobby(snapshot);
    return;
  }

  const phaseMessages = {
    hiding: [`ROUND ${snapshot.round.round}`, "PAINT & HIDE", "Sample a wall. Change your shape. Become scenery."],
    hunting: [`ROUND ${snapshot.round.round}`, "THE HUNT IS ON", "Move carefully. Look twice. Trust no object."]
  } as const;
  const copy = phaseMessages[snapshot.round.phase];
  phaseKicker.textContent = copy[0];
  phaseTitle.textContent = copy[1];
  phaseCopy.textContent = copy[2];
  phaseScreen.classList.remove("hidden");
  phaseTimeout = window.setTimeout(() => phaseScreen.classList.add("hidden"), 2_100);
  playTone(snapshot.round.phase === "hunting" ? 220 : 440, 0.12);
}

function updateLobby(snapshot: ServerSnapshot): void {
  if (snapshot.round.phase !== "waiting") {
    startGameButton.classList.add("hidden");
    return;
  }
  const isOwner = snapshot.selfId === snapshot.ownerId;
  const enoughPlayers = snapshot.players.length >= GAME.minPlayers;
  phaseKicker.textContent = `GAME ${snapshot.gameId} · ${snapshot.players.length}/${GAME.maxPlayers} PLAYERS`;
  phaseTitle.textContent = isOwner ? "YOUR LOBBY" : "GAME LOBBY";
  phaseCopy.textContent = isOwner
    ? enoughPlayers
      ? "Free roam is active. Start the game whenever everyone is ready."
      : `Free roam while waiting for ${GAME.minPlayers - snapshot.players.length} more player.`
    : enoughPlayers
      ? "Free roam is active. Waiting for the game owner to start."
      : "Free roam is active. Waiting for another player to join.";
  startGameButton.classList.toggle("hidden", !isOwner);
  startGameButton.disabled = !enoughPlayers;
  startGameButton.textContent = enoughPlayers ? "START GAME" : "NEED 2 PLAYERS";
}

function requestRoundStart(): void {
  const snapshot = latestSnapshot;
  if (!snapshot || snapshot.round.phase !== "waiting" || snapshot.ownerId !== snapshot.selfId || snapshot.players.length < GAME.minPlayers) return;
  connection?.send({ type: "startGame" });
  startGameButton.disabled = true;
  startGameButton.textContent = "STARTING…";
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
  world.canvas.classList.toggle("paint-cursor", paintMode);
  if (!paintMode && active) showToast("PAINTING IS ONLY AVAILABLE TO ACTIVE HIDERS");
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
  pendingPaintStrokes.push(...world.paintBrushLineAtScreen(from.x, from.y, clientX, clientY, paintColor, brushSize));
  lastPaintPoint = { x: clientX, y: clientY };
  schedulePaintFlush();
}

function queuePaintLine(clientX: number, clientY: number): void {
  queuedPaintPoint = { x: clientX, y: clientY };
  if (paintFrameQueued) return;
  paintFrameQueued = true;
  world.scheduleBeforeRender(paintQueuedLineBeforeRender);
}

function paintQueuedLineBeforeRender(): void {
  paintFrameQueued = false;
  const point = queuedPaintPoint;
  queuedPaintPoint = undefined;
  if (point && paintMode && painting) paintLineTo(point.x, point.y);
}

function flushQueuedPaintLine(): void {
  world.cancelBeforeRender(paintQueuedLineBeforeRender);
  paintFrameQueued = false;
  const point = queuedPaintPoint;
  queuedPaintPoint = undefined;
  if (point && paintMode && painting) paintLineTo(point.x, point.y);
}

function schedulePaintFlush(): void {
  if (paintFlushTimer || pendingPaintStrokes.length === 0) return;
  paintFlushTimer = window.setTimeout(flushPaintStrokes, 30);
}

function flushPaintStrokes(): void {
  paintFlushTimer = 0;
  // Projected face strokes contain several transform values. Keep each JSON
  // packet comfortably below the server's 16 KiB WebSocket payload limit.
  const strokes = pendingPaintStrokes.splice(0, MAX_PAINT_STROKES_PER_PACKET);
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
  world.cancelBeforeRender(paintQueuedLineBeforeRender);
  paintFrameQueued = false;
  queuedPaintPoint = undefined;
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

async function copyGameId(): Promise<void> {
  const gameId = gameCode.textContent?.trim() ?? "";
  if (!/^[A-Z0-9]{6}$/.test(gameId)) return;
  try {
    await navigator.clipboard.writeText(gameId);
    showToast(`GAME ID ${gameId} COPIED`);
  } catch {
    showToast(`GAME ID · ${gameId}`);
  }
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

function stripLegacyGameIdFromUrl(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("gameId")) return;
  url.searchParams.delete("gameId");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function cleanHomeUrl(): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function leaveGame(): void {
  window.clearInterval(inputTimer);
  inputTimer = 0;
  connection?.close();
  connection = undefined;
  window.location.replace(cleanHomeUrl());
}

function reloadCleanHome(): void {
  window.location.replace(cleanHomeUrl());
}

window.addEventListener("beforeunload", () => {
  window.clearInterval(lobbyPollTimer);
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
