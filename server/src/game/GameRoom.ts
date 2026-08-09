import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  GAME,
  PLAYER_POSES,
  PROTOCOL_VERSION,
  SPAWN_POINTS,
  WORLD_BOXES,
  clamp,
  encodeServerMessage,
  isHexColor,
  isPaintPart,
  type ClientMessage,
  type GameEvent,
  type InputPayload,
  type PlayerState,
  type PaintStroke,
  type Pose,
  type RoundState,
  type ServerMessage
} from "@mechfall/shared";
import { moveBody } from "./physics.js";

interface RoomPlayer extends PlayerState {
  socket?: WebSocket;
  input: InputPayload;
  lastInputAt: number;
  lastShotAt: number;
  lastWhistleAt: number;
  lastPaintAt: number;
  paintStrokes: PaintStroke[];
}

export class GameRoom {
  readonly id: string;
  readonly createdAt = Date.now();
  lastHumanAt = Date.now();
  private players = new Map<string, RoomPlayer>();
  private sequence = 0;
  private tickTimer: NodeJS.Timeout;
  private snapshotTimer: NodeJS.Timeout;
  private pendingEvent?: GameEvent;
  private nextHunterOffset = 0;
  private ownerId?: string;
  private round: RoundState = { phase: "waiting", endsAt: 0, round: 0 };

  constructor(id = randomUUID().slice(0, 6).toUpperCase()) {
    this.id = id;
    this.tickTimer = setInterval(() => this.tick(1 / GAME.tickRate), 1000 / GAME.tickRate);
    this.snapshotTimer = setInterval(() => this.broadcastSnapshot(), 1000 / GAME.snapshotRate);
  }

  get humanCount(): number {
    return this.players.size;
  }

  get full(): boolean {
    return this.humanCount >= GAME.maxPlayers;
  }

  addHuman(socket: WebSocket, name: string): RoomPlayer {
    const id = randomUUID().slice(0, 8);
    const player = this.createPlayer(id, sanitizeName(name));
    player.socket = socket;
    player.role = this.round.phase === "waiting" ? "hider" : "spectator";
    this.players.set(id, player);
    this.ownerId ??= id;
    this.lastHumanAt = Date.now();
    this.pendingEvent = { type: "join", player: player.name };
    this.send(socket, { type: "welcome", id, gameId: this.id, protocol: PROTOCOL_VERSION });
    this.sendSnapshot(player);
    this.send(socket, {
      type: "paintState",
      players: [...this.players.values()].map((roomPlayer) => ({ playerId: roomPlayer.id, strokes: roomPlayer.paintStrokes }))
    });
    return player;
  }

  removeHuman(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);
    if (this.ownerId === playerId) this.ownerId = this.players.keys().next().value as string | undefined;
    this.lastHumanAt = Date.now();
    this.pendingEvent = { type: "leave", player: player.name };
  }

  handleMessage(playerId: string, message: ClientMessage): void {
    const player = this.players.get(playerId);
    if (!player) return;

    if (message.type === "input") this.applyInput(player, message.input);
    if (message.type === "paintStroke") this.applyPaintStrokes(player, [message.stroke]);
    if (message.type === "paintStrokes") this.applyPaintStrokes(player, message.strokes);
    if (message.type === "clearPaint" && player.role === "hider" && player.alive) {
      player.paintStrokes = [];
      this.broadcast({ type: "paintReset", playerId: player.id });
    }
    if (message.type === "pose" && player.role === "hider" && player.alive && isPose(message.pose)) player.pose = message.pose;
    if (message.type === "shoot") this.tryShoot(player, message.yaw, message.pitch);
    if (message.type === "startGame") this.tryStartGame(player.id);
    if (message.type === "whistle") this.tryWhistle(player);
    if (message.type === "ping") this.send(player.socket, { type: "pong", sentAt: Number(message.sentAt) || 0, serverTime: Date.now() });
  }

  destroy(): void {
    clearInterval(this.tickTimer);
    clearInterval(this.snapshotTimer);
    for (const player of this.players.values()) player.socket?.close(1001, "Room closed");
  }

  private createPlayer(id: string, name: string): RoomPlayer {
    const spawn = SPAWN_POINTS[this.players.size % SPAWN_POINTS.length] ?? [0, 0, 0];
    return {
      id,
      name,
      position: { x: spawn[0], y: spawn[1], z: spawn[2] },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      role: "hider",
      pose: "stand",
      color: "#f5f0df",
      alive: true,
      score: 0,
      tags: 0,
      whistlingUntil: 0,
      input: { sequence: 0, forward: 0, strafe: 0, jump: false, sprint: false, yaw: 0 },
      lastInputAt: Date.now(),
      lastShotAt: 0,
      lastWhistleAt: 0,
      lastPaintAt: 0,
      paintStrokes: []
    };
  }

  private applyInput(player: RoomPlayer, input: InputPayload): void {
    if (!Number.isFinite(input.sequence) || !Number.isFinite(input.forward) || !Number.isFinite(input.strafe) || !Number.isFinite(input.yaw)) return;
    if (input.sequence <= player.input.sequence) return;
    player.input = {
      sequence: Math.floor(input.sequence),
      forward: clamp(input.forward, -1, 1),
      strafe: clamp(input.strafe, -1, 1),
      jump: Boolean(input.jump),
      sprint: Boolean(input.sprint),
      yaw: normalizeAngle(input.yaw)
    };
    player.yaw = player.input.yaw;
    player.lastInputAt = Date.now();
  }

  private applyPaintStrokes(player: RoomPlayer, strokes: PaintStroke[]): void {
    const now = Date.now();
    if (player.role !== "hider" || !player.alive || now - player.lastPaintAt < 20) return;
    if (!Array.isArray(strokes)) return;
    const safeStrokes = strokes.slice(0, 64).map((stroke) => this.sanitizePaintStroke(stroke)).filter((stroke): stroke is PaintStroke => Boolean(stroke));
    if (safeStrokes.length === 0) return;
    player.lastPaintAt = now;
    player.paintStrokes.push(...safeStrokes);
    if (player.paintStrokes.length > 600) player.paintStrokes.splice(0, player.paintStrokes.length - 600);
    this.broadcast({ type: "paintStrokes", playerId: player.id, strokes: safeStrokes });
  }

  private sanitizePaintStroke(stroke: PaintStroke): PaintStroke | undefined {
    if (!stroke || !isPaintPart(stroke.part) || !isHexColor(stroke.color)) return undefined;
    if (!Number.isFinite(stroke.u) || !Number.isFinite(stroke.v) || !Number.isFinite(stroke.size)) return undefined;
    return {
      part: stroke.part,
      u: clamp(stroke.u, 0, 1),
      v: clamp(stroke.v, 0, 1),
      color: stroke.color.toLowerCase(),
      size: clamp(stroke.size, 0.015, 0.22)
    };
  }

  private tick(dt: number): void {
    const now = Date.now();
    this.updateRound(now);

    for (const player of this.players.values()) {
      if (!player.alive || player.role === "spectator") continue;

      const frozen = this.round.phase === "results" || (this.round.phase === "hiding" && player.role === "hunter");
      const stale = now - player.lastInputAt > GAME.inputTimeoutMs;
      const forward = frozen || stale ? 0 : player.input.forward;
      const strafe = frozen || stale ? 0 : player.input.strafe;
      const sin = Math.sin(player.yaw);
      const cos = Math.cos(player.yaw);
      const wishX = -sin * forward + cos * strafe;
      const wishZ = -cos * forward - sin * strafe;
      const sprinting = player.input.sprint && (Math.abs(forward) > 0.05 || Math.abs(strafe) > 0.05);
      const speed = player.pose !== "stand"
        ? GAME.crouchSpeed
        : sprinting
          ? player.role === "hunter" ? GAME.hunterSprintSpeed : GAME.sprintSpeed
          : player.role === "hunter" ? GAME.hunterSpeed : GAME.moveSpeed;
      moveBody(player, wishX, wishZ, speed, !frozen && player.input.jump, dt);
      player.input.jump = false;
    }
  }

  private updateRound(now: number): void {
    if (this.humanCount < GAME.minPlayers) {
      if (this.round.phase !== "waiting") this.returnToLobby();
      return;
    }

    if (this.round.phase === "waiting") return;

    if (this.round.phase === "hunting") {
      const huntersRemain = [...this.players.values()].some((player) => player.role === "hunter" && player.alive);
      const hidersRemain = [...this.players.values()].some((player) => player.role === "hider" && player.alive);
      if (!huntersRemain) {
        this.round = { phase: "results", endsAt: now + GAME.resultsSeconds * 1000, round: this.round.round, winner: "hiders" };
        return;
      }
      if (!hidersRemain) {
        this.round = { phase: "results", endsAt: now + GAME.resultsSeconds * 1000, round: this.round.round, winner: "hunters" };
        return;
      }
    }

    if (now < this.round.endsAt) return;
    if (this.round.phase === "hiding") {
      this.round = { phase: "hunting", endsAt: now + GAME.huntingSeconds * 1000, round: this.round.round };
    } else if (this.round.phase === "hunting") {
      this.round = { phase: "results", endsAt: now + GAME.resultsSeconds * 1000, round: this.round.round, winner: "hiders" };
    } else if (this.round.phase === "results") {
      this.returnToLobby();
    }
  }

  private tryStartGame(playerId: string): void {
    if (playerId !== this.ownerId || this.round.phase !== "waiting" || this.humanCount < GAME.minPlayers) return;
    this.beginRound(Date.now());
  }

  private returnToLobby(): void {
    for (const player of this.players.values()) {
      player.role = "hider";
      player.alive = true;
      player.pose = "stand";
      player.velocity = { x: 0, y: 0, z: 0 };
    }
    this.round = { phase: "waiting", endsAt: 0, round: this.round.round };
  }

  private beginRound(now: number): void {
    const participants = [...this.players.values()];
    const hunterCount = Math.max(1, Math.floor(participants.length / 5));
    for (let index = 0; index < participants.length; index += 1) {
      const player = participants[index]!;
      const roleIndex = (index - this.nextHunterOffset + participants.length) % participants.length;
      player.role = roleIndex < hunterCount ? "hunter" : "hider";
      player.alive = true;
      player.pose = "stand";
      player.color = player.role === "hunter" ? "#ff5d52" : "#f5f0df";
      player.whistlingUntil = 0;
      player.paintStrokes = [];
      const spawn = SPAWN_POINTS[index % SPAWN_POINTS.length] ?? [0, 0, 0];
      player.position = { x: spawn[0], y: spawn[1], z: spawn[2] };
      player.velocity = { x: 0, y: 0, z: 0 };
    }
    this.nextHunterOffset = (this.nextHunterOffset + hunterCount) % participants.length;
    this.round = { phase: "hiding", endsAt: now + GAME.hidingSeconds * 1000, round: this.round.round + 1 };
    this.broadcast({ type: "paintReset" });
  }

  private tryShoot(hunter: RoomPlayer, requestedYaw: number, requestedPitch: number): void {
    const now = Date.now();
    if (
      this.round.phase !== "hunting"
      || hunter.role !== "hunter"
      || !hunter.alive
      || !Number.isFinite(requestedYaw)
      || !Number.isFinite(requestedPitch)
      || now - hunter.lastShotAt < GAME.shotgunCooldownMs
    ) return;
    hunter.lastShotAt = now;
    hunter.yaw = normalizeAngle(requestedYaw);
    hunter.input.yaw = hunter.yaw;

    // The camera's normal third-person pitch is -0.22. Treat that as a level
    // muzzle and retain a small amount of vertical aiming for jumps/ledges.
    const pitch = clamp(requestedPitch + 0.22, -0.12, 0.12);
    const horizontal = Math.cos(pitch);
    const direction = {
      x: -Math.sin(hunter.yaw) * horizontal,
      y: Math.sin(pitch),
      z: -Math.cos(hunter.yaw) * horizontal
    };
    const origin = { x: hunter.position.x, y: hunter.position.y + 1.28, z: hunter.position.z };
    const blockedAt = firstWorldHit(origin, direction, GAME.shotgunRange);
    let closest: RoomPlayer | undefined;
    let closestDistance = blockedAt;
    for (const target of this.players.values()) {
      if (target.role !== "hider" || !target.alive) continue;
      const dx = target.position.x - origin.x;
      const dy = target.position.y + 1.05 - origin.y;
      const dz = target.position.z - origin.z;
      const along = dx * direction.x + dy * direction.y + dz * direction.z;
      if (along <= 0 || along >= closestDistance) continue;
      const perpendicularSquared = Math.max(0, dx * dx + dy * dy + dz * dz - along * along);
      const spreadRadius = 0.68 + along * 0.035;
      if (perpendicularSquared > spreadRadius * spreadRadius) continue;
      closest = target;
      closestDistance = along;
    }

    const endDistance = closest ? closestDistance : blockedAt;
    const end = {
      x: origin.x + direction.x * endDistance,
      y: origin.y + direction.y * endDistance,
      z: origin.z + direction.z * endDistance
    };
    if (closest) {
      closest.alive = false;
      closest.role = "spectator";
      closest.pose = "stand";
      hunter.tags += 1;
      hunter.score += 100;
    }
    this.pendingEvent = {
      type: "shot",
      hunterId: hunter.id,
      hunter: hunter.name,
      origin,
      end,
      hider: closest?.name
    };
  }

  private tryWhistle(player: RoomPlayer): void {
    const now = Date.now();
    if (player.role !== "hider" || !player.alive || now - player.lastWhistleAt < GAME.whistleCooldownMs) return;
    player.lastWhistleAt = now;
    player.whistlingUntil = now + 1_600;
    player.score += 15;
    this.pendingEvent = { type: "whistle", player: player.name };
  }

  private broadcastSnapshot(): void {
    this.sequence += 1;
    for (const player of this.players.values()) if (player.socket?.readyState === 1) this.sendSnapshot(player);
    this.pendingEvent = undefined;
  }

  private sendSnapshot(player: RoomPlayer): void {
    this.send(player.socket, {
      type: "snapshot",
      serverTime: Date.now(),
      sequence: this.sequence,
      selfId: player.id,
      gameId: this.id,
      ownerId: this.ownerId,
      players: [...this.players.values()].map(({ socket: _socket, input: _input, lastInputAt: _lastInputAt, lastShotAt: _lastShotAt, lastWhistleAt: _lastWhistleAt, lastPaintAt: _lastPaintAt, paintStrokes: _paintStrokes, ...state }) => state),
      round: this.round,
      event: this.pendingEvent
    });
  }

  private send(socket: WebSocket | undefined, message: ServerMessage): void {
    if (socket?.readyState === 1) socket.send(encodeServerMessage(message), { binary: true });
  }

  private broadcast(message: ServerMessage): void {
    for (const player of this.players.values()) this.send(player.socket, message);
  }
}

function sanitizeName(name: string): string {
  const clean = String(name ?? "").replace(/[^a-z0-9 _-]/gi, "").trim().slice(0, 18);
  return clean || `Drifter ${Math.floor(Math.random() * 900 + 100)}`;
}

function isPose(value: unknown): value is Pose {
  return typeof value === "string" && PLAYER_POSES.includes(value as Pose);
}

function normalizeAngle(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function firstWorldHit(origin: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }, maxDistance: number): number {
  let nearest = maxDistance;
  for (const box of WORLD_BOXES) {
    if (!box.solid) continue;
    let enter = 0;
    let exit = nearest;
    for (let axis = 0; axis < 3; axis += 1) {
      const originAxis = axis === 0 ? origin.x : axis === 1 ? origin.y : origin.z;
      const directionAxis = axis === 0 ? direction.x : axis === 1 ? direction.y : direction.z;
      const minimum = box.position[axis]! - box.size[axis]! / 2;
      const maximum = box.position[axis]! + box.size[axis]! / 2;
      if (Math.abs(directionAxis) < 1e-7) {
        if (originAxis < minimum || originAxis > maximum) {
          enter = Number.POSITIVE_INFINITY;
          break;
        }
        continue;
      }
      const first = (minimum - originAxis) / directionAxis;
      const second = (maximum - originAxis) / directionAxis;
      enter = Math.max(enter, Math.min(first, second));
      exit = Math.min(exit, Math.max(first, second));
      if (enter > exit) break;
    }
    if (enter >= 0 && enter <= exit) nearest = Math.min(nearest, enter);
  }
  return nearest;
}
