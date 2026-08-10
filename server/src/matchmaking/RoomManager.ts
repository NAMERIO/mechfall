import { randomUUID } from "node:crypto";
import { GAME, type FindGameError, type OpenLobbySummary } from "@mechfall/shared";
import { GameRoom } from "../game/GameRoom.js";

interface Ticket {
  gameId: string;
  expiresAt: number;
  waitingOnly: boolean;
}

export type FindGameResult =
  | { gameId: string; ticket: string }
  | { error: FindGameError };

const TICKET_TTL_MS = 30_000;
const EMPTY_ROOM_TTL_MS = 60_000;
const DEFAULT_MAX_PENDING_EMPTY_ROOMS = 16;
const MAX_LISTED_LOBBIES = 50;

export class RoomManager {
  private rooms = new Map<string, GameRoom>();
  private tickets = new Map<string, Ticket>();
  private cleanupTimer: NodeJS.Timeout;

  constructor(private readonly maxPendingEmptyRooms = DEFAULT_MAX_PENDING_EMPTY_ROOMS) {
    this.cleanupTimer = setInterval(() => this.cleanup(), 30_000);
    this.cleanupTimer.unref();
  }

  findGame(requestedGameId?: string): FindGameResult {
    const gameId = requestedGameId?.trim().toUpperCase();
    let room: GameRoom | undefined;
    if (requestedGameId !== undefined) {
      if (!gameId || !/^[A-Z0-9]{6}$/.test(gameId)) return { error: "invalid_game_id" };
      room = this.rooms.get(gameId);
      if (!room) return { error: "invalid_game_id" };
      if (room.full) return { error: "full" };
      if (!room.isWaiting) return { error: "not_joinable" };
    } else {
      room = [...this.rooms.values()].find((candidate) => candidate.isWaiting && candidate.humanCount > 0 && !candidate.full);
    }
    if (!room) return this.createGame();
    return this.issueTicket(room);
  }

  createGame(): FindGameResult {
    this.cleanup();
    const pendingEmptyRooms = [...this.rooms.values()].filter((room) => room.humanCount === 0).length;
    if (pendingEmptyRooms >= Math.max(0, Math.floor(this.maxPendingEmptyRooms))) return { error: "server_busy" };

    const room = this.createRoom();
    if (!room) return { error: "server_busy" };
    return this.issueTicket(room);
  }

  listOpenLobbies(): OpenLobbySummary[] {
    return [...this.rooms.values()]
      .filter((room) => room.isWaiting && room.humanCount > 0 && !room.full && room.ownerName)
      .sort((left, right) => right.humanCount - left.humanCount
        || left.createdAt - right.createdAt
        || left.id.localeCompare(right.id))
      .slice(0, MAX_LISTED_LOBBIES)
      .map((room) => ({
        gameId: room.id,
        ownerName: room.ownerName!,
        playerCount: room.humanCount,
        maxPlayers: GAME.maxPlayers
      }));
  }

  private createRoom(): GameRoom | undefined {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const room = new GameRoom();
      if (!this.rooms.has(room.id)) {
        this.rooms.set(room.id, room);
        return room;
      }
      room.destroy();
    }
    return undefined;
  }

  private issueTicket(room: GameRoom): FindGameResult {
    const ticket = randomUUID();
    this.tickets.set(ticket, { gameId: room.id, expiresAt: Date.now() + TICKET_TTL_MS, waitingOnly: true });
    return { gameId: room.id, ticket };
  }

  consumeTicket(ticket: string, gameId: string): GameRoom | undefined {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!entry || entry.gameId !== gameId || entry.expiresAt < Date.now()) return undefined;
    const room = this.rooms.get(gameId);
    if (!room || (entry.waitingOnly && !room.isWaiting)) return undefined;
    return room;
  }

  hasGame(gameId: string): boolean {
    return this.rooms.has(gameId);
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  get playerCount(): number {
    return [...this.rooms.values()].reduce((count, room) => count + room.humanCount, 0);
  }

  close(): void {
    clearInterval(this.cleanupTimer);
    for (const room of this.rooms.values()) room.destroy();
    this.rooms.clear();
    this.tickets.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [ticket, entry] of this.tickets) if (entry.expiresAt < now) this.tickets.delete(ticket);
    for (const [id, room] of this.rooms) {
      if (room.humanCount === 0 && now - room.lastHumanAt > EMPTY_ROOM_TTL_MS) {
        room.destroy();
        this.rooms.delete(id);
      }
    }
  }
}
