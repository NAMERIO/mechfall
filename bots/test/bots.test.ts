import assert from "node:assert/strict";
import test from "node:test";
import { SPAWN_POINTS } from "@mechfall/shared";
import { camouflageBatches } from "../src/camouflage.ts";
import { readConfig } from "../src/config.ts";
import { BUNKER_DOORS, NavigationMap } from "../src/navigation.ts";

test("bunker navigation keeps authored doors open and connects interior spawns", () => {
  const navigation = new NavigationMap();
  for (const opening of BUNKER_DOORS) assert.equal(navigation.lineClear(opening.min, opening.max), true);
  const first = SPAWN_POINTS[0]!;
  const farInterior = SPAWN_POINTS[10]!;
  const path = navigation.findPath(
    { x: first[0], z: first[2] },
    { x: farInterior[0], z: farInterior[2] }
  );
  assert.ok(path.length >= 2, "expected A* to connect distant bunker rooms");
});

test("hiding spots are reachable and choose a valid camouflage color", () => {
  const navigation = new NavigationMap();
  const origin = { x: -25, z: -20 };
  const hidingSpot = navigation.findHidingSpot(origin, [{ x: 20, z: -20 }], 42);
  assert.ok(navigation.findPath(origin, hidingSpot).length > 0);
  assert.match(navigation.camouflageAt(hidingSpot).color, /^#[0-9a-f]{6}$/i);
});

test("camouflage covers all body parts in packet-sized batches", () => {
  const batches = camouflageBatches("#b0b0b0", "paint-bot1-r1");
  const strokes = batches.flat();
  assert.equal(strokes.length, 150);
  assert.ok(batches.every((batch) => batch.length <= 32));
  assert.deepEqual([...new Set(strokes.map((stroke) => stroke.part))].sort(), [
    "body", "head", "leftArm", "leftLeg", "rightArm", "rightLeg"
  ]);
});

test("CLI bot options override environment defaults", () => {
  const config = readConfig(
    ["--count", "3", "--game=abc123", "--auto-start", "--name", "Sneaky"],
    { BOT_SERVER_URL: "http://127.0.0.1:4000" }
  );
  assert.equal(config.count, 3);
  assert.equal(config.gameId, "ABC123");
  assert.equal(config.autoStart, true);
  assert.equal(config.namePrefix, "Sneaky");
  assert.equal(config.serverUrl, "http://127.0.0.1:4000");
});
