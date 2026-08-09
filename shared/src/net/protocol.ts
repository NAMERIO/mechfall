export const PROTOCOL_VERSION = 8;

export const GAME = {
  tickRate: 30,
  snapshotRate: 20,
  maxPlayers: 12,
  warmupSeconds: 8,
  hidingSeconds: 22,
  huntingSeconds: 120,
  resultsSeconds: 10,
  moveSpeed: 6.2,
  hunterSpeed: 6.65,
  sprintSpeed: 8.4,
  hunterSprintSpeed: 8.75,
  crouchSpeed: 3.2,
  jumpSpeed: 7.3,
  gravity: 20,
  playerRadius: 0.48,
  shotgunRange: 28,
  shotgunCooldownMs: 850,
  whistleCooldownMs: 12_000,
  inputTimeoutMs: 1_000
} as const;

export type Role = "hunter" | "hider" | "spectator";
export const PLAYER_POSES = [
  "stand",
  "aPose",
  "backBend",
  "bridge",
  "crossLegged",
  "crouchedFetal",
  "curledUp",
  "fetal",
  "handOnHip",
  "layDown",
  "handUp",
  "mermaid",
  "openWide",
  "sideLying",
  "sit",
  "tPose",
  "tree",
  "wideSquat"
] as const;
export type Pose = (typeof PLAYER_POSES)[number];
export type RoundPhase = "waiting" | "hiding" | "hunting" | "results";
export type PaintPart = "body" | "head" | "leftArm" | "rightArm" | "leftLeg" | "rightLeg";

export interface PaintStroke {
  part: PaintPart;
  u: number;
  v: number;
  color: string;
  size: number;
}

export interface PlayerPaintState {
  playerId: string;
  strokes: PaintStroke[];
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PlayerState {
  id: string;
  name: string;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  role: Role;
  pose: Pose;
  color: string;
  alive: boolean;
  score: number;
  tags: number;
  bot: boolean;
  whistlingUntil: number;
}

export interface RoundState {
  phase: RoundPhase;
  endsAt: number;
  round: number;
  winner?: "hunters" | "hiders";
}

export interface ServerSnapshot {
  type: "snapshot";
  serverTime: number;
  sequence: number;
  selfId: string;
  gameId: string;
  players: PlayerState[];
  round: RoundState;
  event?: GameEvent;
}

export type GameEvent =
  | { type: "shot"; hunterId: string; hunter: string; origin: Vec3; end: Vec3; hider?: string }
  | { type: "whistle"; player: string }
  | { type: "join"; player: string }
  | { type: "leave"; player: string };

export interface InputPayload {
  sequence: number;
  forward: number;
  strafe: number;
  jump: boolean;
  sprint: boolean;
  yaw: number;
}

export type ClientMessage =
  | { type: "hello"; protocol: number; name: string; ticket: string }
  | { type: "input"; input: InputPayload }
  | { type: "paintStroke"; stroke: PaintStroke }
  | { type: "paintStrokes"; strokes: PaintStroke[] }
  | { type: "clearPaint" }
  | { type: "pose"; pose: Pose }
  | { type: "shoot"; yaw: number; pitch: number }
  | { type: "whistle" }
  | { type: "ping"; sentAt: number };

export type ServerMessage =
  | ServerSnapshot
  | { type: "welcome"; id: string; gameId: string; protocol: number }
  | { type: "pong"; sentAt: number; serverTime: number }
  | { type: "paintStroke"; playerId: string; stroke: PaintStroke }
  | { type: "paintStrokes"; playerId: string; strokes: PaintStroke[] }
  | { type: "paintState"; players: PlayerPaintState[] }
  | { type: "paintReset"; playerId?: string }
  | { type: "error"; code: string; message: string };

export interface FindGameMatchData {
  gameId: string;
  ticket: string;
  urls: string[];
  protocol: number;
}

export type FindGameResponse =
  | { type: "success"; res: FindGameMatchData }
  | { type: "error"; error: "full" | "invalid_game_id" | "invalid_protocol" };

export type GameWsDisconnectReason =
  | "game_not_found"
  | "game_full"
  | "invalid_packet"
  | "invalid_protocol"
  | "invalid_ticket"
  | "rate_limited"
  | "server_restart";

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function isPaintPart(value: unknown): value is PaintPart {
  return value === "body" || value === "head" || value === "leftArm" || value === "rightArm" || value === "leftLeg" || value === "rightLeg";
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
