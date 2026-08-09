import { randomUUID } from "node:crypto";
import { GameRoom } from "../game/GameRoom.js";

interface Ticket {
  roomId: string;
  expiresAt: number;
}

export class RoomManager {
  private rooms = new Map<string, GameRoom>();
  private tickets = new Map<string, Ticket>();

  constructor() {
    setInterval(() => this.cleanup(), 30_000).unref();
  }

  matchmake(): { roomId: string; ticket: string } {
    let room = [...this.rooms.values()].find((candidate) => !candidate.full);
    if (!room) {
      room = new GameRoom();
      this.rooms.set(room.id, room);
    }
    const ticket = randomUUID();
    this.tickets.set(ticket, { roomId: room.id, expiresAt: Date.now() + 30_000 });
    return { roomId: room.id, ticket };
  }

  consumeTicket(ticket: string, roomId: string): GameRoom | undefined {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!entry || entry.roomId !== roomId || entry.expiresAt < Date.now()) return undefined;
    return this.rooms.get(roomId);
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  get playerCount(): number {
    return [...this.rooms.values()].reduce((count, room) => count + room.humanCount, 0);
  }

  close(): void {
    for (const room of this.rooms.values()) room.destroy();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [ticket, entry] of this.tickets) if (entry.expiresAt < now) this.tickets.delete(ticket);
    for (const [id, room] of this.rooms) {
      if (room.humanCount === 0 && now - room.lastHumanAt > 60_000) {
        room.destroy();
        this.rooms.delete(id);
      }
    }
  }
}
