import assert from "node:assert/strict";
import test from "node:test";
import { RoomManager } from "../../src/matchmaking/RoomManager.ts";

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
    assert.deepEqual(manager.findGame("bad"), { error: "invalid_game_id" });
    assert.deepEqual(manager.findGame("ABC123"), { error: "invalid_game_id" });
  } finally {
    manager.close();
  }
});
