import assert from "node:assert/strict";
import test from "node:test";
import { GAME } from "@mechfall/shared";
import type { WebSocket } from "ws";
import { RoomManager } from "../../src/matchmaking/RoomManager.ts";

class TestSocket {
  readyState = 1;
  send(): void {}
  close(): void {}
}

const asWebSocket = (socket: TestSocket): WebSocket => socket as unknown as WebSocket;
const delay = (duration: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, duration));
const requireMatch = (result: ReturnType<RoomManager["createGame"]>): Extract<typeof result, { gameId: string }> => {
  assert.ok("gameId" in result, `expected a match, received ${JSON.stringify(result)}`);
  return result;
};
const createConnectedRoom = (manager: RoomManager, ownerName: string) => {
  const match = requireMatch(manager.createGame());
  const room = manager.consumeTicket(match.ticket, match.gameId);
  assert.ok(room);
  const owner = room.addHuman(asWebSocket(new TestSocket()), ownerName);
  return { match, room, owner };
};

test("players can request the same live game by game ID", () => {
  const manager = new RoomManager();
  try {
    const first = manager.findGame();
    assert.ok("gameId" in first);
    const joined = manager.findGame(first.gameId.toLowerCase());
    assert.ok("gameId" in joined);
    assert.equal(joined.gameId, first.gameId);
  } finally {
    manager.close();
  }
});

test("invalid and unknown game IDs are rejected", () => {
  const manager = new RoomManager();
  try {
    assert.deepEqual(manager.findGame(""), { error: "invalid_game_id" });
    assert.deepEqual(manager.findGame("   "), { error: "invalid_game_id" });
    assert.deepEqual(manager.findGame("bad"), { error: "invalid_game_id" });
    assert.deepEqual(manager.findGame("ABC123"), { error: "invalid_game_id" });
  } finally {
    manager.close();
  }
});

test("explicit game creation never reuses an open room and caps pending empty rooms", () => {
  const manager = new RoomManager(2);
  try {
    const first = requireMatch(manager.createGame());
    const second = requireMatch(manager.createGame());
    assert.notEqual(first.gameId, second.gameId);
    assert.deepEqual(manager.createGame(), { error: "server_busy" });
    assert.deepEqual(manager.listOpenLobbies(), [], "rooms without connected humans must not be advertised");
  } finally {
    manager.close();
  }
});

test("automatic matchmaking cannot take ownership of a pending empty game", () => {
  const manager = new RoomManager();
  try {
    const explicit = requireMatch(manager.createGame());
    const automatic = manager.findGame();
    assert.ok("gameId" in automatic);
    assert.notEqual(automatic.gameId, explicit.gameId);
  } finally {
    manager.close();
  }
});

test("open lobby summaries are safe, deterministic, and follow owner transfer", async () => {
  const manager = new RoomManager();
  try {
    const older = createConnectedRoom(manager, "Older Owner");
    await delay(4);
    const fuller = createConnectedRoom(manager, "Fuller Owner");
    fuller.room.addHuman(asWebSocket(new TestSocket()), "Guest");

    const initial = manager.listOpenLobbies();
    assert.deepEqual(initial, [
      {
        gameId: fuller.match.gameId,
        ownerName: "Fuller Owner",
        playerCount: 2,
        maxPlayers: GAME.maxPlayers
      },
      {
        gameId: older.match.gameId,
        ownerName: "Older Owner",
        playerCount: 1,
        maxPlayers: GAME.maxPlayers
      }
    ]);
    assert.deepEqual(Object.keys(initial[0]!).sort(), ["gameId", "maxPlayers", "ownerName", "playerCount"]);

    fuller.room.removeHuman(fuller.owner.id);
    assert.deepEqual(manager.listOpenLobbies().map((lobby) => [lobby.gameId, lobby.ownerName]), [
      [older.match.gameId, "Older Owner"],
      [fuller.match.gameId, "Guest"]
    ]);
  } finally {
    manager.close();
  }
});

test("empty, full, and active games are not advertised", () => {
  const manager = new RoomManager();
  try {
    requireMatch(manager.createGame());

    const full = createConnectedRoom(manager, "Full Owner");
    for (let index = 1; index < GAME.maxPlayers; index += 1) {
      full.room.addHuman(asWebSocket(new TestSocket()), `Full Guest ${index}`);
    }

    const active = createConnectedRoom(manager, "Active Owner");
    active.room.addHuman(asWebSocket(new TestSocket()), "Active Guest");
    active.room.handleMessage(active.owner.id, { type: "startGame" });

    assert.deepEqual(manager.listOpenLobbies(), []);
    assert.deepEqual(manager.findGame(full.match.gameId), { error: "full" });
    assert.deepEqual(manager.findGame(active.match.gameId), { error: "not_joinable" });
  } finally {
    manager.close();
  }
});

test("a waiting-only ticket cannot join after its lobby starts", () => {
  const manager = new RoomManager();
  try {
    const active = createConnectedRoom(manager, "Owner");
    active.room.addHuman(asWebSocket(new TestSocket()), "Guest");
    const pending = manager.findGame(active.match.gameId);
    assert.ok("ticket" in pending);

    active.room.handleMessage(active.owner.id, { type: "startGame" });
    assert.equal(manager.consumeTicket(pending.ticket, pending.gameId), undefined);
  } finally {
    manager.close();
  }
});

test("the public lobby response is capped at fifty entries", () => {
  const manager = new RoomManager();
  try {
    for (let index = 0; index < 51; index += 1) createConnectedRoom(manager, `Owner ${index}`);
    assert.equal(manager.listOpenLobbies().length, 50);
  } finally {
    manager.close();
  }
});
