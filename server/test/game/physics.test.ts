import assert from "node:assert/strict";
import test from "node:test";
import { GAME, worldHullHeightAt } from "@mechfall/shared";
import {
  moveBody,
  moveClingingBody,
  playerContactDistance,
  resolveWorldHullPenetration,
  selectClosestHullClingEdge,
  sweepWorldHull,
  walkableWorldHullHeightAt,
  walkableWorldHullSupportHeightAt,
  worldHullHasSolidTop,
  wantsToDetachFromSurface
} from "../../src/game/physics.ts";

const approximatelyEqual = (actual: number, expected: number, epsilon = 1e-9): void => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
};

test("movement cannot leave the arena", () => {
  const body = { position: { x: 20, y: 0, z: 0 }, velocity: { x: 100, y: 0, z: 0 } };
  moveBody(body, 1, 0, 6, false, 0, 1);
  assert.equal(body.position.x, 20);
  approximatelyEqual(body.velocity.x, 0);
});

test("jump returns to the ground", () => {
  const body = { position: { x: 8, y: 0, z: 8 }, velocity: { x: 0, y: 0, z: 0 } };
  moveBody(body, 0, 0, 0, true, 0, 1 / 30);
  assert.ok(body.position.y > 0);
  for (let index = 0; index < 100; index += 1) moveBody(body, 0, 0, 0, false, 0, 1 / 30);
  assert.equal(body.position.y, 0);
});

test("the standing footprint projects width and depth from yaw", () => {
  approximatelyEqual(playerContactDistance(0, 1, 0), GAME.playerHalfWidth);
  approximatelyEqual(playerContactDistance(0, 0, 1), GAME.playerHalfDepth);
  approximatelyEqual(playerContactDistance(Math.PI / 2, 1, 0), GAME.playerHalfDepth);
  approximatelyEqual(playerContactDistance(Math.PI / 2, 0, 1), GAME.playerHalfWidth);
  approximatelyEqual(playerContactDistance(Math.PI, -1, 0), GAME.playerHalfWidth);
  approximatelyEqual(playerContactDistance(Math.PI, 0, -1), GAME.playerHalfDepth);
  approximatelyEqual(
    playerContactDistance(Math.PI / 4, 1, 0),
    Math.hypot(GAME.playerHalfWidth, GAME.playerHalfDepth) / Math.sqrt(2)
  );
});

test("smooth convex hulls report authoritative angled contact", () => {
  const hull = {
    id: "diamond-hull",
    vertices: [
      [-1, 0, 0], [0, 0, -1], [1, 0, 0], [0, 0, 1],
      [-1, 2, 0], [0, 2, -1], [1, 2, 0], [0, 2, 1]
    ],
    color: "#57b9a9",
    kind: "hull" as const,
    solid: true
  } as const;
  const hit = sweepWorldHull(-3, 0, 0, 0, 0, hull);
  assert.ok(hit);
  approximatelyEqual(Math.hypot(hit.normalX, hit.normalZ), 1);
  assert.ok(hit.normalX < -0.7);
  assert.ok(Math.abs(hit.normalZ) > 0.7);
  assert.ok(hit.time > 0 && hit.time < 1);
});

test("a body left inside a detailed hull corner is resolved during the same tick", () => {
  const hull = {
    id: "corner-hull",
    vertices: [
      [-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1],
      [-1, 2, -1], [1, 2, -1], [1, 2, 1], [-1, 2, 1]
    ],
    color: "#57b9a9",
    kind: "hull" as const,
    solid: true
  } as const;
  const body = {
    position: { x: 1.4, y: 0, z: 1.05 },
    velocity: { x: -5, y: 0, z: -5 }
  };

  assert.equal(resolveWorldHullPenetration(body, 0, hull), true);
  approximatelyEqual(body.position.z, 1 + GAME.playerHalfDepth);
  approximatelyEqual(body.velocity.z, 0);
});

test("triangle collision meshes preserve their local surface height", () => {
  const mesh = {
    id: "sloped-car-shape",
    vertices: [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1], [-1, 1, -1], [1, 2, -1], [1, 2, 1], [-1, 1, 1]],
    triangles: [[4, 5, 6], [4, 6, 7]],
    color: "#57b9a9",
    kind: "hull" as const,
    solid: true
  } as const;
  approximatelyEqual(worldHullHeightAt(mesh, -0.75, 0)!, 1.125);
  approximatelyEqual(worldHullHeightAt(mesh, 0.75, 0)!, 1.875);
  assert.equal(worldHullHeightAt(mesh, 2, 0), undefined);
});

test("vehicle hoods and ramps are walkable while steep model faces stay walls", () => {
  const hood = {
    id: "walkable-hood",
    vertices: [[-1, 0.3, -1], [1, 1.1, -1], [1, 1.1, 1], [-1, 0.3, 1]],
    triangles: [[0, 1, 2], [0, 2, 3]],
    color: "#57b9a9",
    kind: "hull" as const,
    solid: true
  } as const;
  const windshield = {
    id: "steep-windshield",
    vertices: [[-0.25, 0, -1], [0.25, 2, -1], [0.25, 2, 1], [-0.25, 0, 1]],
    triangles: [[0, 1, 2], [0, 2, 3]],
    color: "#57b9a9",
    kind: "hull" as const,
    solid: true
  } as const;

  approximatelyEqual(walkableWorldHullHeightAt(hood, 0, 0)!, 0.7);
  assert.equal(walkableWorldHullHeightAt(windshield, 0, 0), undefined);
});

test("a higher steep car triangle cannot hide behind lower hood support", () => {
  const mixedSurface = {
    id: "mixed-hood-corner",
    vertices: [
      [-1, 0.5, -1], [1, 0.5, -1], [1, 0.5, 1], [-1, 0.5, 1],
      [0.2, 0.6, -0.5], [0.6, 1.6, -0.5], [0.6, 1.6, 0.5], [0.2, 0.6, 0.5]
    ],
    triangles: [[0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7]],
    color: "#57b9a9",
    kind: "hull" as const,
    solid: true
  } as const;

  assert.equal(walkableWorldHullSupportHeightAt(mixedSurface, 0, 0, 0), undefined);
});

test("flat-topped detailed models get continuous edge support without flattening cars", () => {
  const container = {
    id: "flat-container",
    vertices: [
      [-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1],
      [-1, 2, -1], [1, 2, -1], [1, 2, 1], [-1, 2, 1]
    ],
    triangles: [[4, 5, 6], [4, 6, 7]],
    color: "#57b9a9",
    kind: "hull" as const,
    solid: true
  } as const;
  const carHood = {
    id: "irregular-car",
    vertices: [[-1, 0.3, -1], [1, 1.1, -1], [1, 1.1, 1], [-1, 0.3, 1]],
    triangles: [[0, 1, 2], [0, 2, 3]],
    color: "#57b9a9",
    kind: "hull" as const,
    solid: true
  } as const;

  assert.equal(worldHullHasSolidTop(container), true);
  assert.equal(worldHullHasSolidTop(carHood), false);
  approximatelyEqual(walkableWorldHullSupportHeightAt(container, 0, 0, 0)!, 2);
});

test("detailed parallel hull edges attach climbing to the segment beside the player", () => {
  const points = [[-2, 2], [-1.96, 1.8], [-0.84, -4], [1, -4], [2, 2]] as const;
  const start = points[1];
  const end = points[2];
  const deltaX = end[0] - start[0];
  const deltaZ = end[1] - start[1];
  const length = Math.hypot(deltaX, deltaZ);
  const normalX = deltaZ / length;
  const normalZ = -deltaX / length;
  const contactDistance = playerContactDistance(0, normalX, normalZ);
  const position = {
    x: (start[0] + end[0]) / 2 + normalX * contactDistance,
    z: (start[1] + end[1]) / 2 + normalZ * contactDistance
  };

  const matched = selectClosestHullClingEdge(points, position, 0, normalX, normalZ);
  assert.ok(matched);
  assert.deepEqual(matched.start, start);
  assert.deepEqual(matched.end, end);
});

test("back and side collision distances are authoritative on every crate face", () => {
  const faces = [
    { faceX: -7, faceZ: -1, normalX: -1, normalZ: 0, backYaw: Math.PI / 2, sideYaw: 0 },
    { faceX: -2, faceZ: -1, normalX: 1, normalZ: 0, backYaw: -Math.PI / 2, sideYaw: 0 },
    { faceX: -4.5, faceZ: -2, normalX: 0, normalZ: -1, backYaw: 0, sideYaw: Math.PI / 2 },
    { faceX: -4.5, faceZ: 0, normalX: 0, normalZ: 1, backYaw: Math.PI, sideYaw: Math.PI / 2 }
  ] as const;

  for (const face of faces) {
    for (const [label, yaw, expectedDistance] of [
      ["back", face.backYaw, GAME.playerHalfDepth],
      ["side", face.sideYaw, GAME.playerHalfWidth]
    ] as const) {
      const contactX = face.faceX + face.normalX * expectedDistance;
      const contactZ = face.faceZ + face.normalZ * expectedDistance;
      const body = {
        position: {
          x: contactX + face.normalX * 0.08,
          y: 1,
          z: contactZ + face.normalZ * 0.08
        },
        velocity: { x: -face.normalX * 6, y: 0, z: -face.normalZ * 6 }
      };
      const collision = moveBody(body, -face.normalX, -face.normalZ, 6, false, yaw, 0.05);
      assert.deepEqual(collision, {
        surfaceId: "center-red",
        normalX: face.normalX,
        normalZ: face.normalZ
      }, `${label} collision on normal (${face.normalX}, ${face.normalZ})`);
      approximatelyEqual(body.position.x, contactX);
      approximatelyEqual(body.position.z, contactZ);
    }
  }
});

test("rotating while clung keeps every face attached at the new projected distance", () => {
  const faces = [
    { faceX: -7, faceZ: -1, normalX: -1, normalZ: 0, backYaw: Math.PI / 2, sideYaw: 0 },
    { faceX: -2, faceZ: -1, normalX: 1, normalZ: 0, backYaw: -Math.PI / 2, sideYaw: 0 },
    { faceX: -4.5, faceZ: -2, normalX: 0, normalZ: -1, backYaw: 0, sideYaw: Math.PI / 2 },
    { faceX: -4.5, faceZ: 0, normalX: 0, normalZ: 1, backYaw: Math.PI, sideYaw: Math.PI / 2 }
  ] as const;

  for (const face of faces) {
    const body = {
      position: {
        x: face.faceX + face.normalX * GAME.playerHalfDepth,
        y: 1,
        z: face.faceZ + face.normalZ * GAME.playerHalfDepth
      },
      velocity: { x: 0, y: 0, z: 0 }
    };
    const cling = { surfaceId: "center-red", normalX: face.normalX, normalZ: face.normalZ };
    assert.equal(moveClingingBody(body, cling, face.backYaw, 0, 0, 1 / 30), "attached");
    assert.equal(moveClingingBody(body, cling, face.sideYaw, 0, 0, 1 / 30), "attached");
    approximatelyEqual(body.position.x, face.faceX + face.normalX * GAME.playerHalfWidth);
    approximatelyEqual(body.position.z, face.faceZ + face.normalZ * GAME.playerHalfWidth);
    approximatelyEqual(body.velocity.x * face.normalX + body.velocity.z * face.normalZ, 0);
  }
});

test("the outer wall limit uses the yaw-aware back and side footprint", () => {
  const back = { position: { x: 0, y: 0, z: 20 }, velocity: { x: 0, y: 0, z: 6 } };
  assert.deepEqual(moveBody(back, 0, 1, 6, false, 0, 0.1), {
    surfaceId: "south",
    normalX: 0,
    normalZ: -1
  });
  approximatelyEqual(back.position.z, 20.5 - GAME.playerHalfDepth);

  const side = { position: { x: 0, y: 0, z: 19.8 }, velocity: { x: 0, y: 0, z: 6 } };
  assert.deepEqual(moveBody(side, 0, 1, 6, false, Math.PI / 2, 0.1), {
    surfaceId: "south",
    normalX: 0,
    normalZ: -1
  });
  approximatelyEqual(side.position.z, 20.5 - GAME.playerHalfWidth);
});

test("stationary rotation depenetrates on the wall normal without becoming a collision", () => {
  const body = {
    position: { x: 0, y: 0.8, z: -20.5 + GAME.playerHalfDepth },
    velocity: { x: 0, y: 0, z: 0 }
  };
  const collision = moveBody(body, 0, 0, 0, false, Math.PI / 2, 1 / 30);
  assert.equal(collision, undefined);
  approximatelyEqual(body.position.x, 0);
  approximatelyEqual(body.position.z, -20.5 + GAME.playerHalfWidth);
  approximatelyEqual(body.velocity.x, 0);
  approximatelyEqual(body.velocity.z, 0);
});

test("a player can remain fixed on a known collided crate face", () => {
  const body = { position: { x: -7.5, y: 0.8, z: -1 }, velocity: { x: 0, y: -5, z: 0 } };
  const cling = { surfaceId: "center-red", normalX: -1, normalZ: 0 };
  assert.equal(moveClingingBody(body, cling, 0, 0, 0, 1 / 30), "attached");
  assert.equal(body.position.y, 0.8);
  assert.deepEqual(body.velocity, { x: 0, y: 0, z: 0 });
});

test("an expanded-AABB corner collision is not pulled sideways onto the raw face", () => {
  const body = {
    position: { x: -7.56, y: 1, z: GAME.playerHalfDepth - 0.02 },
    velocity: { x: 6, y: 0, z: 0 }
  };
  const collision = moveBody(body, 1, 0, 6, false, 0, 0.05);
  assert.deepEqual(collision, { surfaceId: "center-red", normalX: -1, normalZ: 0 });
  const collidedTangent = body.position.z;

  assert.equal(moveClingingBody(body, collision!, 0, 0, 0, 0), "released");
  assert.equal(body.position.z, collidedTangent);
});

test("surface cling climbs, descends, and slides across an object", () => {
  const body = { position: { x: -7.5, y: 0.5, z: -1 }, velocity: { x: 0, y: 0, z: 0 } };
  const cling = { surfaceId: "center-red", normalX: -1, normalZ: 0 };
  moveClingingBody(body, cling, 0, 1, 1, 0.25);
  assert.ok(body.position.y > 0.5);
  assert.ok(body.position.z > -1);
  const climbedY = body.position.y;
  moveClingingBody(body, cling, 0, 0, -1, 0.1);
  assert.ok(body.position.y < climbedY);
});

test("Space/Shift climb vertically and A/D slide both ways along a clung surface", () => {
  const body = { position: { x: -7.5, y: 1, z: -1 }, velocity: { x: 0, y: 0, z: 0 } };
  const cling = { surfaceId: "center-red", normalX: -1, normalZ: 0 };
  const step = 0.1;

  assert.equal(moveClingingBody(body, cling, 0, 0, 1, step), "attached");
  approximatelyEqual(body.position.y, 1 + GAME.climbSpeed * step);
  approximatelyEqual(body.velocity.y, GAME.climbSpeed);

  assert.equal(moveClingingBody(body, cling, 0, 0, -1, step), "attached");
  approximatelyEqual(body.position.y, 1);
  approximatelyEqual(body.velocity.y, -GAME.climbSpeed);

  assert.equal(moveClingingBody(body, cling, 0, 1, 0, step), "attached");
  approximatelyEqual(body.position.z, -1 + GAME.climbSpeed * step);
  approximatelyEqual(body.velocity.z, GAME.climbSpeed);

  assert.equal(moveClingingBody(body, cling, 0, -1, 0, step), "attached");
  approximatelyEqual(body.position.z, -1);
  approximatelyEqual(body.velocity.z, -GAME.climbSpeed);
  assert.equal(body.position.x, -7.5);
});

test("A/D follow the oriented tangent on every vertical face", () => {
  const faces = [
    { body: { x: -7.5, y: 1, z: -1 }, yaw: 0, cling: { surfaceId: "center-red", normalX: -1, normalZ: 0 } },
    { body: { x: -1.5, y: 1, z: -1 }, yaw: 0, cling: { surfaceId: "center-red", normalX: 1, normalZ: 0 } },
    { body: { x: -4.5, y: 1, z: -2 - GAME.playerHalfDepth }, yaw: 0, cling: { surfaceId: "center-red", normalX: 0, normalZ: -1 } },
    { body: { x: -4.5, y: 1, z: GAME.playerHalfDepth }, yaw: 0, cling: { surfaceId: "center-red", normalX: 0, normalZ: 1 } }
  ] as const;

  for (const face of faces) {
    const body = { position: { ...face.body }, velocity: { x: 0, y: 0, z: 0 } };
    const start = { ...body.position };
    assert.equal(moveClingingBody(body, face.cling, face.yaw, 1, 0, 0.1), "attached");
    const tangentX = face.cling.normalZ;
    const tangentZ = -face.cling.normalX;
    approximatelyEqual(body.position.x - start.x, tangentX * GAME.climbSpeed * 0.1);
    approximatelyEqual(body.position.z - start.z, tangentZ * GAME.climbSpeed * 0.1);
    approximatelyEqual(body.velocity.x, tangentX * GAME.climbSpeed);
    approximatelyEqual(body.velocity.z, tangentZ * GAME.climbSpeed);

    assert.equal(moveClingingBody(body, face.cling, face.yaw, -1, 0, 0.1), "attached");
    approximatelyEqual(body.position.x, start.x);
    approximatelyEqual(body.position.z, start.z);
    approximatelyEqual(body.velocity.x, -tangentX * GAME.climbSpeed);
    approximatelyEqual(body.velocity.z, -tangentZ * GAME.climbSpeed);
  }
});

test("signed forward-axis input detaches only when its world direction points away", () => {
  const faces = [
    { cling: { surfaceId: "west-face", normalX: -1, normalZ: 0 }, towardYaw: -Math.PI / 2, awayYaw: Math.PI / 2 },
    { cling: { surfaceId: "east-face", normalX: 1, normalZ: 0 }, towardYaw: Math.PI / 2, awayYaw: -Math.PI / 2 },
    { cling: { surfaceId: "north-face", normalX: 0, normalZ: -1 }, towardYaw: Math.PI, awayYaw: 0 },
    { cling: { surfaceId: "south-face", normalX: 0, normalZ: 1 }, towardYaw: 0, awayYaw: Math.PI }
  ] as const;

  for (const { cling, towardYaw, awayYaw } of faces) {
    assert.equal(wantsToDetachFromSurface(cling, towardYaw, 1), false);
    assert.equal(wantsToDetachFromSurface(cling, towardYaw, -1), true);
    assert.equal(wantsToDetachFromSurface(cling, awayYaw, 1), true);
    assert.equal(wantsToDetachFromSurface(cling, awayYaw, -1), false);
  }
});

test("leaving a side edge releases while climbing over the top mantles", () => {
  const cling = { surfaceId: "center-red", normalX: -1, normalZ: 0 };
  const sideEdge = { position: { x: -7.5, y: 1, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
  assert.equal(moveClingingBody(sideEdge, cling, 0, 1, 0, 1 / 30), "released");
  assert.equal(sideEdge.position.z, 0);
  approximatelyEqual(sideEdge.velocity.z, 0);

  const topEdge = { position: { x: -7.5, y: 2.72, z: -1 }, velocity: { x: 0, y: 0, z: 0 } };
  assert.equal(moveClingingBody(topEdge, cling, 0, 0, 1, 1 / 30), "mantled");
  approximatelyEqual(topEdge.position.x, -6.47);
  approximatelyEqual(topEdge.position.y, 3);
  approximatelyEqual(topEdge.velocity.x, 0);
  approximatelyEqual(topEdge.velocity.y, 0);
});

test("mantling crosses each crate face and settles fully on top", () => {
  const faces = [
    { position: { x: -7.5, y: 2.72, z: -1 }, normalX: -1, normalZ: 0, expectedX: -6.47, expectedZ: -1 },
    { position: { x: -1.5, y: 2.72, z: -1 }, normalX: 1, normalZ: 0, expectedX: -2.53, expectedZ: -1 },
    { position: { x: -4.5, y: 2.72, z: -2.14 }, normalX: 0, normalZ: -1, expectedX: -4.5, expectedZ: -1.83 },
    { position: { x: -4.5, y: 2.72, z: 0.14 }, normalX: 0, normalZ: 1, expectedX: -4.5, expectedZ: -0.17 }
  ] as const;

  for (const face of faces) {
    const body = { position: { ...face.position }, velocity: { x: 0, y: 0, z: 0 } };
    const cling = { surfaceId: "center-red", normalX: face.normalX, normalZ: face.normalZ };
    assert.equal(moveClingingBody(body, cling, 0, 0, 1, 1 / 30), "mantled");
    approximatelyEqual(body.position.x, face.expectedX);
    approximatelyEqual(body.position.z, face.expectedZ);
    approximatelyEqual(body.position.y, 3);
    assert.deepEqual(body.velocity, { x: 0, y: 0, z: 0 });
  }
});

test("a stacked obstacle blocks the mantle without releasing or pushing", () => {
  const body = { position: { x: 13.5, y: 1.72, z: -10 }, velocity: { x: 0, y: 0, z: 0 } };
  const cling = { surfaceId: "yellow-stack-a", normalX: 1, normalZ: 0 };
  assert.equal(moveClingingBody(body, cling, 0, 0, 1, 1 / 30), "attached");
  approximatelyEqual(body.position.x, 13.5);
  approximatelyEqual(body.position.y, 1.72);
  approximatelyEqual(body.velocity.x, 0);
  approximatelyEqual(body.velocity.y, 0);
  approximatelyEqual(body.velocity.z, 0);
});

test("falling lands on an object top and remains supported", () => {
  const body = { position: { x: -2, y: 1.6, z: -13 }, velocity: { x: 0, y: -4, z: 0 } };
  moveBody(body, 0, 0, 0, false, 0, 0.1);
  approximatelyEqual(body.position.y, 1.3);
  approximatelyEqual(body.velocity.y, 0);

  for (let index = 0; index < 60; index += 1) moveBody(body, 0, 0, 0, false, 0, 1 / 30);
  approximatelyEqual(body.position.y, 1.3);
  approximatelyEqual(body.velocity.y, 0);
});

test("a player can jump from a platform and naturally fall after walking off", () => {
  const jumper = { position: { x: -2, y: 1.3, z: -13 }, velocity: { x: 0, y: 0, z: 0 } };
  moveBody(jumper, 0, 0, 0, true, 0, 1 / 30);
  assert.ok(jumper.position.y > 1.3);
  assert.ok(jumper.velocity.y > 0);

  const walker = { position: { x: -5.3, y: 1.3, z: -13 }, velocity: { x: 0, y: 0, z: 0 } };
  moveBody(walker, -1, 0, 6, false, 0, 0.2);
  assert.ok(walker.position.y < 1.3);
  assert.ok(walker.velocity.y < 0);
  for (let index = 0; index < 80; index += 1) moveBody(walker, 0, 0, 0, false, 0, 1 / 30);
  approximatelyEqual(walker.position.y, 0);
});

test("the inner half of an arena wall can be mantled without escaping the arena", () => {
  const yaw = Math.PI / 2;
  const body = { position: { x: -20.36, y: 4.72, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
  const cling = { surfaceId: "west", normalX: 1, normalZ: 0 };
  assert.equal(moveClingingBody(body, cling, yaw, 0, 1, 1 / 30), "mantled");
  approximatelyEqual(body.position.x, -20.67);
  approximatelyEqual(body.position.y, 5);
  assert.deepEqual(body.velocity, { x: 0, y: 0, z: 0 });

  for (let index = 0; index < 30; index += 1) moveBody(body, 0, 0, 0, false, yaw, 1 / 30);
  approximatelyEqual(body.position.y, 5);
  assert.ok(body.position.x >= -21 + GAME.playerHalfDepth);
});
