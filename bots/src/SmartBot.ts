import WebSocket, { type RawData } from "ws";
import {
  GAME,
  PLAYER_POSES,
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage,
  type FindGameMatchData,
  type InputPayload,
  type PlayerState,
  type ServerSnapshot
} from "@mechfall/shared";
import type { BotConfig } from "./config.ts";
import { camouflageBatches } from "./camouflage.ts";
import { NavigationMap, asNavPoint, type NavPoint } from "./navigation.ts";

const INPUT_INTERVAL_MS = 100;
const REPATH_INTERVAL_MS = 900;
const TARGET_REACHED_DISTANCE = 0.85;

export class SmartBot {
  private socket?: WebSocket;
  private snapshot?: ServerSnapshot;
  private selfId?: string;
  private inputSequence = 0;
  private inputTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private route: NavPoint[] = [];
  private routeIndex = 0;
  private routeTarget?: NavPoint;
  private lastRouteAt = 0;
  private hideTarget?: NavPoint;
  private paintedRound = -1;
  private observedState = "";
  private lastStartAt = 0;
  private lastShotAt = 0;
  private lastFleeAt = 0;
  private hunterTargetId?: string;
  private lastHunterSelectionAt = 0;
  private roamUntil = 0;
  private decisionSeed = 1;
  private progressPoint?: NavPoint;
  private progressAt = Date.now();

  constructor(
    readonly index: number,
    readonly name: string,
    private readonly config: BotConfig,
    private readonly navigation: NavigationMap
  ) {
    this.decisionSeed = index * 7_919;
  }

  async play(match: FindGameMatchData): Promise<void> {
    this.resetConnectionState();
    const socket = new WebSocket(normalizePlayUrl(match.urls[0]!, this.config.serverUrl));
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => socket.close(4_000, "connect_timeout"), 8_000);
      socket.once("open", () => {
        this.send({ type: "hello", protocol: PROTOCOL_VERSION, name: this.name, ticket: match.ticket });
      });
      socket.on("message", (data, isBinary) => {
        if (!isBinary) {
          socket.close(4_000, "invalid_packet");
          return;
        }
        const message = decodeServerMessage(rawDataBytes(data));
        if (!message) {
          socket.close(4_000, "invalid_packet");
          return;
        }
        if (message.type === "welcome") {
          clearTimeout(timeout);
          this.selfId = message.id;
          console.log(`[${this.name}] joined lobby ${message.gameId}`);
          this.startTimers();
        } else if (message.type === "snapshot") {
          this.snapshot = message;
          this.logState(message);
        } else if (message.type === "error") {
          console.warn(`[${this.name}] server error: ${message.message}`);
        }
      });
      socket.on("error", (error) => console.warn(`[${this.name}] websocket error: ${error.message}`));
      socket.once("close", (_code, reason) => {
        clearTimeout(timeout);
        this.stopTimers();
        if (this.socket === socket) this.socket = undefined;
        const suffix = reason.length ? ` (${reason.toString()})` : "";
        console.log(`[${this.name}] disconnected${suffix}`);
        resolve();
      });
    });
  }

  stop(): void {
    this.stopTimers();
    this.socket?.close(1_000, "Bot stopped");
  }

  private startTimers(): void {
    this.stopTimers();
    this.inputTimer = setInterval(() => this.update(), INPUT_INTERVAL_MS);
    this.pingTimer = setInterval(() => this.send({ type: "ping", sentAt: Date.now() }), 2_000);
  }

  private stopTimers(): void {
    if (this.inputTimer) clearInterval(this.inputTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.inputTimer = undefined;
    this.pingTimer = undefined;
  }

  private update(): void {
    const snapshot = this.snapshot;
    const self = snapshot?.players.find((player) => player.id === this.selfId);
    if (!snapshot || !self) return;
    if (!self.alive || self.role === "spectator" || snapshot.round.phase === "results") {
      this.sendInput(self, { forward: 0, positionLocked: false });
      return;
    }

    if (snapshot.round.phase === "waiting") {
      this.runLobbyBehavior(snapshot, self);
      return;
    }
    if (self.role === "hunter") {
      this.runHunterBehavior(snapshot, self);
      return;
    }
    this.runHiderBehavior(snapshot, self);
  }

  private runLobbyBehavior(snapshot: ServerSnapshot, self: PlayerState): void {
    const now = Date.now();
    if (this.config.autoStart && snapshot.ownerId === self.id && snapshot.players.length >= GAME.minPlayers && now - this.lastStartAt > 2_000) {
      this.lastStartAt = now;
      this.send({ type: "startGame" });
    }
    if (!this.routeTarget || now >= this.roamUntil || distance(asNavPoint(self.position), this.routeTarget) < TARGET_REACHED_DISTANCE) {
      this.decisionSeed += 1;
      const destination = this.navigation.findRoamPoint(asNavPoint(self.position), this.decisionSeed);
      this.setRoute(asNavPoint(self.position), destination);
      this.roamUntil = now + 7_000 + (this.index % 4) * 800;
    }
    this.followRoute(self, false);
  }

  private runHiderBehavior(snapshot: ServerSnapshot, self: PlayerState): void {
    const now = Date.now();
    const hunters = snapshot.players.filter((player) => player.role === "hunter" && player.alive);
    if (this.paintedRound !== snapshot.round.round) {
      this.paintedRound = snapshot.round.round;
      this.decisionSeed += snapshot.round.round * 17;
      this.hideTarget = this.navigation.findHidingSpot(
        asNavPoint(self.position),
        hunters.map((hunter) => asNavPoint(hunter.position)),
        this.decisionSeed
      );
      this.setRoute(asNavPoint(self.position), this.hideTarget);
      const camouflage = this.navigation.camouflageAt(this.hideTarget);
      const actionId = `paint-bot${this.index}-r${snapshot.round.round}`;
      for (const strokes of camouflageBatches(camouflage.color, actionId)) this.send({ type: "paintStrokes", strokes });
      const pose = PLAYER_POSES[(this.index * 5 + snapshot.round.round) % PLAYER_POSES.length]!;
      this.send({ type: "pose", pose });
      this.send({ type: "paintRotation", roll: (this.index % 4) * Math.PI / 2 });
      console.log(`[${this.name}] hiding near ${camouflage.surface}, painted ${camouflage.color}`);
    }

    const nearestHunter = hunters.sort((left, right) => distance3(self, left) - distance3(self, right))[0];
    const hunterDistance = nearestHunter ? distance3(self, nearestHunter) : Infinity;
    if (snapshot.round.phase === "hunting" && nearestHunter && hunterDistance < 8 && now - this.lastFleeAt > 4_000) {
      this.lastFleeAt = now;
      this.decisionSeed += 1;
      this.hideTarget = this.navigation.findHidingSpot(asNavPoint(self.position), [asNavPoint(nearestHunter.position)], this.decisionSeed);
      this.setRoute(asNavPoint(self.position), this.hideTarget);
    }

    if (this.hideTarget && distance(asNavPoint(self.position), this.hideTarget) <= TARGET_REACHED_DISTANCE) {
      this.sendInput(self, { forward: 0, positionLocked: snapshot.round.phase === "hunting" });
      return;
    }
    if (this.hideTarget) this.followRoute(self, true);
    else this.sendInput(self, { forward: 0, positionLocked: false });
  }

  private runHunterBehavior(snapshot: ServerSnapshot, self: PlayerState): void {
    if (snapshot.round.phase === "hiding") {
      this.sendInput(self, { forward: 0, positionLocked: false });
      return;
    }
    const targets = snapshot.players
      .filter((player) => player.role === "hider" && player.alive)
      .sort((left, right) => distance3(self, left) - distance3(self, right));
    let target = targets.find((candidate) => candidate.id === this.hunterTargetId);
    if (!target || Date.now() - this.lastHunterSelectionAt > 2_000) {
      target = targets.find((candidate) => this.navigation.findPath(asNavPoint(self.position), asNavPoint(candidate.position)).length > 0);
      this.hunterTargetId = target?.id;
      this.lastHunterSelectionAt = Date.now();
    }
    if (!target) {
      this.sendInput(self, { forward: 0, positionLocked: false });
      return;
    }
    const aim = aimAt(self, target);
    const targetPoint = asNavPoint(target.position);
    const targetDistance = distance3(self, target);
    const visible = targetDistance <= GAME.shotgunRange - 1 && this.navigation.lineClear(asNavPoint(self.position), targetPoint);
    if (visible && Date.now() - this.lastShotAt >= GAME.shotgunCooldownMs + 80) {
      this.lastShotAt = Date.now();
      this.send({ type: "shoot", yaw: aim.yaw, pitch: aim.pitch });
    }
    if (targetDistance > 5) {
      this.followRoute(self, true, targetPoint, aim);
    } else {
      this.sendInput(self, { forward: targetDistance > 2.5 ? 0.65 : 0, sprint: false, yaw: aim.yaw, aimYaw: aim.yaw, pitch: aim.pitch, positionLocked: false });
    }
  }

  private followRoute(self: PlayerState, sprint: boolean, destination = this.routeTarget, aim?: { yaw: number; pitch: number }): void {
    if (!destination) {
      this.sendInput(self, { forward: 0, positionLocked: false });
      return;
    }
    const current = asNavPoint(self.position);
    const targetChanged = !this.routeTarget || distance(destination, this.routeTarget) > 2;
    if (targetChanged || Date.now() - this.lastRouteAt > REPATH_INTERVAL_MS || this.route.length === 0) this.setRoute(current, destination);
    while (this.routeIndex < this.route.length && distance(current, this.route[this.routeIndex]!) < TARGET_REACHED_DISTANCE) this.routeIndex += 1;
    const waypoint = this.route[this.routeIndex] ?? destination;
    const movementYaw = Math.atan2(-(waypoint.x - current.x), -(waypoint.z - current.z));
    const stuck = this.isStuck(current);
    if (stuck) {
      this.lastRouteAt = 0;
      this.progressAt = Date.now();
    }
    this.sendInput(self, {
      forward: 1,
      sprint,
      jump: stuck,
      yaw: movementYaw,
      aimYaw: aim?.yaw ?? movementYaw,
      pitch: aim?.pitch ?? -0.22,
      positionLocked: false
    });
  }

  private setRoute(from: NavPoint, to: NavPoint): void {
    this.routeTarget = to;
    this.route = this.navigation.findPath(from, to);
    this.routeIndex = this.route.length > 1 ? 1 : 0;
    this.lastRouteAt = Date.now();
  }

  private isStuck(current: NavPoint): boolean {
    if (!this.progressPoint || distance(current, this.progressPoint) > 0.4) {
      this.progressPoint = current;
      this.progressAt = Date.now();
      return false;
    }
    return Date.now() - this.progressAt > 1_300;
  }

  private sendInput(self: PlayerState, overrides: Partial<InputPayload>): void {
    this.inputSequence += 1;
    this.send({
      type: "input",
      input: {
        sequence: this.inputSequence,
        forward: overrides.forward ?? 0,
        strafe: overrides.strafe ?? 0,
        jump: overrides.jump ?? false,
        sprint: overrides.sprint ?? false,
        climb: overrides.climb ?? 0,
        detach: overrides.detach ?? false,
        positionLocked: overrides.positionLocked ?? false,
        yaw: overrides.yaw ?? self.yaw,
        aimYaw: overrides.aimYaw ?? overrides.yaw ?? self.aimYaw ?? self.yaw,
        pitch: overrides.pitch ?? self.aimPitch ?? -0.22
      }
    });
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encodeClientMessage(message), { binary: true });
  }

  private logState(snapshot: ServerSnapshot): void {
    const self = snapshot.players.find((player) => player.id === this.selfId);
    if (!self) return;
    const state = `${snapshot.gameId}:${snapshot.round.round}:${snapshot.round.phase}:${self.role}:${self.alive}`;
    if (state === this.observedState) return;
    this.observedState = state;
    console.log(`[${this.name}] ${snapshot.round.phase} · ${self.role}${self.alive ? "" : " · out"}`);
  }

  private resetConnectionState(): void {
    this.snapshot = undefined;
    this.selfId = undefined;
    this.inputSequence = 0;
    this.route = [];
    this.routeTarget = undefined;
    this.hideTarget = undefined;
    this.hunterTargetId = undefined;
    this.paintedRound = -1;
    this.observedState = "";
  }
}

function normalizePlayUrl(rawUrl: string, serverUrl: string): string {
  const play = new URL(rawUrl);
  const server = new URL(serverUrl);
  if (play.hostname === "0.0.0.0" || play.hostname === "::") play.hostname = server.hostname;
  if (server.protocol === "https:") play.protocol = "wss:";
  return play.toString();
}

function rawDataBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function aimAt(source: PlayerState, target: PlayerState): { yaw: number; pitch: number } {
  const dx = target.position.x - source.position.x;
  const dz = target.position.z - source.position.z;
  const dy = target.position.y + 1.15 - (source.position.y + GAME.hunterEyeHeight);
  return {
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.max(-0.85, Math.min(0.48, Math.atan2(dy, Math.hypot(dx, dz)) - 0.22))
  };
}

function distance3(first: PlayerState, second: PlayerState): number {
  return Math.hypot(
    first.position.x - second.position.x,
    first.position.y - second.position.y,
    first.position.z - second.position.z
  );
}

function distance(first: NavPoint, second: NavPoint): number {
  return Math.hypot(first.x - second.x, first.z - second.z);
}
