import assert from "node:assert/strict";
import test from "node:test";
import { moveBody } from "../../src/game/physics.ts";

test("movement cannot leave the arena", () => {
  const body = { position: { x: 20, y: 0, z: 0 }, velocity: { x: 100, y: 0, z: 0 } };
  moveBody(body, 1, 0, 6, false, 1);
  assert.ok(body.position.x <= 20);
});

test("jump returns to the ground", () => {
  const body = { position: { x: 8, y: 0, z: 8 }, velocity: { x: 0, y: 0, z: 0 } };
  moveBody(body, 0, 0, 0, true, 1 / 30);
  assert.ok(body.position.y > 0);
  for (let index = 0; index < 100; index += 1) moveBody(body, 0, 0, 0, false, 1 / 30);
  assert.equal(body.position.y, 0);
});
