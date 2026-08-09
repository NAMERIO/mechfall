import assert from "node:assert/strict";
import test from "node:test";
import { decodeServerMessage, type ServerSnapshot } from "@mechfall/shared";
import type { WebSocket } from "ws";
import { GameRoom } from "../../src/game/GameRoom.ts";

class TestSocket {
  readyState = 1;
  sent: Uint8Array[] = [];
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {}
}

const asWebSocket = (socket: TestSocket): WebSocket => socket as unknown as WebSocket;
const delay = (duration: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, duration));
const latestSnapshot = (socket: TestSocket): ServerSnapshot => {
  const snapshots = socket.sent
    .map((packet) => decodeServerMessage(packet))
    .filter((message): message is ServerSnapshot => message?.type === "snapshot");
  const snapshot = snapshots.at(-1);
  assert.ok(snapshot);
  return snapshot;
};

test("a human-only lobby requires the owner and two players to start", async () => {
  const room = new GameRoom("ABC123");
  try {
    const ownerSocket = new TestSocket();
    const guestSocket = new TestSocket();
    const owner = room.addHuman(asWebSocket(ownerSocket), "Owner");
    await delay(60);
    const soloSnapshot = latestSnapshot(ownerSocket);
    assert.equal(soloSnapshot.players.length, 1);
    assert.equal(soloSnapshot.ownerId, owner.id);
    assert.equal(soloSnapshot.round.phase, "waiting");

    const guest = room.addHuman(asWebSocket(guestSocket), "Guest");
    room.handleMessage(guest.id, { type: "startGame" });
    await delay(60);
    assert.equal(latestSnapshot(ownerSocket).round.phase, "waiting");

    room.handleMessage(owner.id, { type: "startGame" });
    await delay(60);
    assert.equal(latestSnapshot(ownerSocket).round.phase, "hiding");
  } finally {
    room.destroy();
  }
});

test("lobby ownership transfers when the owner leaves", async () => {
  const room = new GameRoom("DEF456");
  try {
    const firstSocket = new TestSocket();
    const secondSocket = new TestSocket();
    const first = room.addHuman(asWebSocket(firstSocket), "First");
    const second = room.addHuman(asWebSocket(secondSocket), "Second");
    room.removeHuman(first.id);
    await delay(60);
    const snapshot = latestSnapshot(secondSocket);
    assert.equal(snapshot.players.length, 1);
    assert.equal(snapshot.ownerId, second.id);
    assert.equal(snapshot.round.phase, "waiting");
  } finally {
    room.destroy();
  }
});
