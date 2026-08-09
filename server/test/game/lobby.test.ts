import assert from "node:assert/strict";
import test from "node:test";
import {
  GAME,
  decodeServerMessage,
  type ClientMessage,
  type GameEvent,
  type PlayerState,
  type RoundState,
  type ServerSnapshot
} from "@mechfall/shared";
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
const CENTER_RED_WEST_FACE = -7;
const BACK_TO_WALL_YAW = Math.PI / 2;
const SIDE_TO_WALL_YAW = 0;
const DEPTH_CONTACT_X = CENTER_RED_WEST_FACE - GAME.playerHalfDepth;
const SIDE_CONTACT_X = CENTER_RED_WEST_FACE - GAME.playerHalfWidth;
const setRound = (room: GameRoom, round: RoundState): void => {
  (room as unknown as { round: RoundState }).round = round;
};
const shotEvents = (socket: TestSocket): Extract<GameEvent, { type: "shot" }>[] =>
  socket.sent
    .map((packet) => decodeServerMessage(packet))
    .filter((message): message is ServerSnapshot => message?.type === "snapshot")
    .flatMap((snapshot) => snapshot.event?.type === "shot" ? [snapshot.event] : []);
const waitForShot = async (socket: TestSocket, timeoutMs = 1_200): Promise<Extract<GameEvent, { type: "shot" }>> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const shot = shotEvents(socket).at(-1);
    if (shot) return shot;
    await delay(15);
  }
  assert.fail("timed out waiting for a shot event");
};
const latestSnapshot = (socket: TestSocket): ServerSnapshot => {
  const snapshots = socket.sent
    .map((packet) => decodeServerMessage(packet))
    .filter((message): message is ServerSnapshot => message?.type === "snapshot");
  const snapshot = snapshots.at(-1);
  assert.ok(snapshot);
  return snapshot;
};

test("hunter shots use camera yaw without changing authoritative body facing", async () => {
  const room = new GameRoom("AIM001");
  try {
    const hunterSocket = new TestSocket();
    const hiderSocket = new TestSocket();
    const hunter = room.addHuman(asWebSocket(hunterSocket), "Hunter");
    const hider = room.addHuman(asWebSocket(hiderSocket), "Camera Target");
    await delay(60);
    hunterSocket.sent.length = 0;

    setRound(room, { phase: "hunting", endsAt: Date.now() + 10_000, round: 1 });
    hunter.role = "hunter";
    hunter.alive = true;
    hunter.position = { x: 0, y: 0, z: 8 };
    hunter.velocity = { x: 0, y: 0, z: 0 };
    hunter.yaw = 0.42;
    hunter.input.yaw = 0.42;
    hider.role = "hider";
    hider.alive = true;
    hider.position = { x: 5, y: 0, z: 8 };
    hider.velocity = { x: 0, y: 0, z: 0 };

    room.handleMessage(hunter.id, { type: "shoot", yaw: -Math.PI / 2, pitch: -0.22 });

    assert.equal(hunter.yaw, 0.42);
    assert.equal(hunter.input.yaw, 0.42);
    assert.equal(hider.alive, false);
    assert.equal(hider.role, "spectator");
    const shot = await waitForShot(hunterSocket);
    assert.equal(shot.hider, "Camera Target");
    assert.ok(shot.end.x > shot.origin.x);
    assert.ok(Math.abs(shot.end.z - shot.origin.z) < 0.001);
    assert.equal(latestPlayer(hunterSocket, hunter.id)?.yaw, 0.42);
  } finally {
    room.destroy();
  }
});

test("hiders and hunters outside the hunting phase cannot shoot or change facing state", async () => {
  const room = new GameRoom("AIM002");
  try {
    const requesterSocket = new TestSocket();
    const targetSocket = new TestSocket();
    const requester = room.addHuman(asWebSocket(requesterSocket), "Requester");
    const target = room.addHuman(asWebSocket(targetSocket), "Target");
    await delay(60);
    requesterSocket.sent.length = 0;

    setRound(room, { phase: "hunting", endsAt: Date.now() + 10_000, round: 1 });
    requester.role = "hider";
    requester.alive = true;
    requester.yaw = 0.31;
    requester.input.yaw = 0.31;
    target.role = "hunter";
    target.alive = true;
    room.handleMessage(requester.id, { type: "shoot", yaw: -1.2, pitch: -0.22 });
    await delay(70);
    assert.equal(shotEvents(requesterSocket).length, 0);
    assert.equal(requester.lastShotAt, 0);
    assert.equal(requester.yaw, 0.31);
    assert.equal(requester.input.yaw, 0.31);
    assert.equal(target.alive, true);

    requesterSocket.sent.length = 0;
    setRound(room, { phase: "hiding", endsAt: Date.now() + 10_000, round: 2 });
    requester.role = "hunter";
    target.role = "hider";
    room.handleMessage(requester.id, { type: "shoot", yaw: 1.2, pitch: -0.22 });
    await delay(70);
    assert.equal(shotEvents(requesterSocket).length, 0);
    assert.equal(requester.lastShotAt, 0);
    assert.equal(requester.yaw, 0.31);
    assert.equal(requester.input.yaw, 0.31);
    assert.equal(target.alive, true);
  } finally {
    room.destroy();
  }
});
const latestPlayer = (socket: TestSocket, playerId: string): PlayerState | undefined =>
  latestSnapshot(socket).players.find((candidate) => candidate.id === playerId);
const waitForPlayer = async (
  socket: TestSocket,
  playerId: string,
  predicate: (player: PlayerState) => boolean,
  description: string,
  timeoutMs = 1_200
): Promise<PlayerState> => {
  const deadline = Date.now() + timeoutMs;
  let player = latestPlayer(socket, playerId);
  while (Date.now() < deadline) {
    if (player && predicate(player)) return player;
    await delay(15);
    player = latestPlayer(socket, playerId);
  }
  assert.fail(`timed out waiting for ${description}; latest player was ${JSON.stringify(player)}`);
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

test("movement packets without cling fields still move players", async () => {
  const room = new GameRoom("MOVE01");
  try {
    const socket = new TestSocket();
    const player = room.addHuman(asWebSocket(socket), "Mover");
    const before = latestSnapshot(socket).players.find((candidate) => candidate.id === player.id)!.position;
    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 1, forward: 1, strafe: 0, jump: false, sprint: false, yaw: 0 }
    });
    await delay(80);
    const after = latestSnapshot(socket).players.find((candidate) => candidate.id === player.id)!.position;
    assert.ok(after.z < before.z, `expected forward movement, but z stayed at ${after.z}`);
  } finally {
    room.destroy();
  }
});

test("the authoritative room uses Space/Shift/A/D crawl controls and facing-wall S detach", async () => {
  const room = new GameRoom("CLING1");
  try {
    const socket = new TestSocket();
    const player = room.addHuman(asWebSocket(socket), "Crawler");
    player.position = { x: DEPTH_CONTACT_X - 0.08, y: 0.8, z: -1 };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.yaw = -Math.PI / 2;

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 1, forward: 1, strafe: 0, jump: false, sprint: false, yaw: -Math.PI / 2 }
    });
    const attached = await waitForPlayer(
      socket,
      player.id,
      (state) => state.cling?.surfaceId === "center-red",
      "automatic contact attachment"
    );

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 2, forward: 1, strafe: 0, jump: false, sprint: false, climb: 0, yaw: -Math.PI / 2 }
    });
    await delay(80);
    const pressedW = latestPlayer(socket, player.id)!;
    assert.equal(pressedW.cling?.surfaceId, "center-red");
    assert.ok(Math.abs(pressedW.position.y - attached.position.y) < 0.001, "W must not change cling height");

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 4, forward: 0, strafe: 0, jump: true, sprint: false, climb: 1, yaw: -Math.PI / 2 }
    });
    const climbed = await waitForPlayer(socket, player.id, (state) => Boolean(state.cling) && state.position.y > pressedW.position.y + 0.02, "Space climb");

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 5, forward: 0, strafe: 0, jump: false, sprint: true, climb: -1, detach: false, yaw: -Math.PI / 2 }
    });
    const descended = await waitForPlayer(socket, player.id, (state) => Boolean(state.cling) && state.position.y < climbed.position.y - 0.02, "held Shift descent");

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 6, forward: 0, strafe: 0, jump: false, sprint: false, climb: 0, detach: false, yaw: -Math.PI / 2 }
    });
    await delay(80);
    const releasedShift = latestPlayer(socket, player.id)!;
    await delay(80);
    const stoppedAfterRelease = latestPlayer(socket, player.id)!;
    assert.equal(releasedShift.cling?.surfaceId, "center-red");
    assert.equal(stoppedAfterRelease.cling?.surfaceId, "center-red");
    assert.ok(Math.abs(stoppedAfterRelease.position.y - releasedShift.position.y) < 0.001, "releasing Shift must stop descent");
    assert.ok(Math.abs(stoppedAfterRelease.velocity.y) < 0.001, "released Shift must clear vertical cling velocity");

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 7, forward: 0, strafe: 1, jump: false, sprint: false, climb: 0, detach: false, yaw: -Math.PI / 2 }
    });
    const slidRight = await waitForPlayer(socket, player.id, (state) => Boolean(state.cling) && state.position.z > stoppedAfterRelease.position.z + 0.02, "D slide");

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 8, forward: 0, strafe: -1, jump: false, sprint: false, climb: 0, detach: false, yaw: -Math.PI / 2 }
    });
    const slidLeft = await waitForPlayer(socket, player.id, (state) => Boolean(state.cling) && state.position.z < slidRight.position.z - 0.02, "A slide");
    assert.ok(slidLeft.position.y <= climbed.position.y);

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 9, forward: -1, strafe: 0, jump: false, sprint: false, climb: 0, detach: false, yaw: -Math.PI / 2 }
    });
    const detached = await waitForPlayer(socket, player.id, (state) => !state.cling && state.position.x < DEPTH_CONTACT_X, "facing-wall backward detach");
    assert.ok(detached.velocity.x < 0);
  } finally {
    room.destroy();
  }
});

test("a nearby stationary player remains unclung until actual wall collision", async () => {
  const room = new GameRoom("NOMAG1");
  try {
    const socket = new TestSocket();
    const player = room.addHuman(asWebSocket(socket), "No Magnet");
    player.position = { x: -7.7, y: 0.8, z: -1 };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.yaw = -Math.PI / 2;

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 1, forward: 0, strafe: 0, jump: false, sprint: false, climb: 0, detach: false, yaw: -Math.PI / 2 }
    });
    await delay(100);
    const nearby = latestPlayer(socket, player.id)!;
    assert.equal(nearby.cling, undefined);
    assert.ok(Math.abs(nearby.position.x - -7.7) < 0.001, "nearby surface must not pull the player to contact");

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 2, forward: 1, strafe: 0, jump: false, sprint: false, climb: 0, detach: false, yaw: -Math.PI / 2 }
    });
    const attached = await waitForPlayer(
      socket,
      player.id,
      (state) => state.cling?.surfaceId === "center-red",
      "actual collision attachment"
    );
    assert.ok(Math.abs(attached.position.x - DEPTH_CONTACT_X) < 0.001);
  } finally {
    room.destroy();
  }
});

test("the authoritative room keeps back and side contact aligned while a clung player rotates", async () => {
  const room = new GameRoom("TURN01");
  try {
    const socket = new TestSocket();
    const player = room.addHuman(asWebSocket(socket), "Turning Crawler");
    player.position = { x: DEPTH_CONTACT_X - 0.12, y: 0.8, z: -1 };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.yaw = BACK_TO_WALL_YAW;

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 1, forward: -1, strafe: 0, jump: false, sprint: false, climb: 0, detach: false, yaw: BACK_TO_WALL_YAW }
    });
    const attachedBackFirst = await waitForPlayer(
      socket,
      player.id,
      (state) => state.cling?.surfaceId === "center-red",
      "back-first collision attachment"
    );
    assert.ok(Math.abs(attachedBackFirst.position.x - DEPTH_CONTACT_X) < 0.001);

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 2, forward: 0, strafe: 0, jump: false, sprint: false, climb: 0, detach: false, yaw: SIDE_TO_WALL_YAW }
    });
    const sideOn = await waitForPlayer(
      socket,
      player.id,
      (state) => state.cling?.surfaceId === "center-red" && Math.abs(state.position.x - SIDE_CONTACT_X) < 0.001,
      "side-on cling contact"
    );
    assert.ok(Math.abs(sideOn.velocity.x) < 0.001, "rotation contact correction must not create normal velocity");

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 3, forward: 0, strafe: 0, jump: false, sprint: false, climb: 0, detach: false, yaw: BACK_TO_WALL_YAW }
    });
    const backOnWall = await waitForPlayer(
      socket,
      player.id,
      (state) => state.cling?.surfaceId === "center-red" && Math.abs(state.position.x - DEPTH_CONTACT_X) < 0.001,
      "rotated-back cling contact"
    );
    assert.ok(Math.abs(backOnWall.velocity.x) < 0.001);
    assert.ok(Math.abs(backOnWall.position.z - sideOn.position.z) < 0.001);
  } finally {
    room.destroy();
  }
});

test("stationary yaw expansion resolves on the wall normal without auto-attaching", async () => {
  const room = new GameRoom("TURN02");
  try {
    const socket = new TestSocket();
    const player = room.addHuman(asWebSocket(socket), "Free Turner");
    player.position = { x: 0, y: 0.8, z: -20.5 + GAME.playerHalfDepth };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.yaw = 0;

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 1, forward: 0, strafe: 0, jump: false, sprint: false, climb: 0, detach: false, yaw: Math.PI / 2 }
    });
    const rotated = await waitForPlayer(
      socket,
      player.id,
      (state) => Math.abs(state.position.z - (-20.5 + GAME.playerHalfWidth)) < 0.001,
      "rotation-only normal depenetration"
    );
    assert.equal(rotated.cling, undefined);
    assert.ok(Math.abs(rotated.position.x) < 0.001, "rotation must not resolve along the wall tangent");
    assert.ok(Math.abs(rotated.velocity.x) < 0.001);
    assert.ok(Math.abs(rotated.velocity.z) < 0.001);
  } finally {
    room.destroy();
  }
});

test("residual movement still auto-attaches on actual wall contact", async () => {
  const room = new GameRoom("CLING2");
  try {
    const socket = new TestSocket();
    const player = room.addHuman(asWebSocket(socket), "Coasting Crawler");
    player.position = { x: DEPTH_CONTACT_X - 0.2, y: 0.8, z: -1 };
    player.velocity = { x: 6, y: 0, z: 0 };
    player.yaw = -Math.PI / 2;

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 1, forward: 0, strafe: 0, jump: false, sprint: false, climb: 0, detach: false, yaw: -Math.PI / 2 }
    });
    await waitForPlayer(
      socket,
      player.id,
      (state) => state.cling?.surfaceId === "center-red",
      "contact attachment after movement input is released"
    );
  } finally {
    room.destroy();
  }
});

test("a latched Space press climbs even when a newer key-up arrives before the tick", async () => {
  const room = new GameRoom("CLMB01");
  try {
    const socket = new TestSocket();
    const player = room.addHuman(asWebSocket(socket), "Space Crawler");
    player.position = { x: DEPTH_CONTACT_X, y: 0.8, z: -1 };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.yaw = -Math.PI / 2;
    player.cling = { surfaceId: "center-red", normalX: -1, normalZ: 0 };
    await waitForPlayer(socket, player.id, (state) => state.cling?.surfaceId === "center-red", "initial attached state");

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 1, forward: 0, strafe: 0, jump: true, sprint: false, climb: 1, yaw: -Math.PI / 2 }
    });
    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 2, forward: 0, strafe: 0, jump: false, sprint: false, climb: 0, yaw: -Math.PI / 2 }
    });

    const climbed = await waitForPlayer(
      socket,
      player.id,
      (state) => state.cling?.surfaceId === "center-red" && state.position.y > 0.82,
      "latched Space climb"
    );
    assert.ok(Math.abs(climbed.position.x - DEPTH_CONTACT_X) < 0.001);
    await delay(120);
    assert.equal(latestPlayer(socket, player.id)?.cling?.surfaceId, "center-red");
  } finally {
    room.destroy();
  }
});

test("held Shift descends and releasing it stops without detaching", async () => {
  const room = new GameRoom("DROP01");
  try {
    const socket = new TestSocket();
    const player = room.addHuman(asWebSocket(socket), "Drop Crawler");
    player.position = { x: DEPTH_CONTACT_X, y: 1.4, z: -1 };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.yaw = -Math.PI / 2;
    player.cling = { surfaceId: "center-red", normalX: -1, normalZ: 0 };
    await waitForPlayer(socket, player.id, (state) => state.cling?.surfaceId === "center-red", "initial Shift-test attachment");

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 1, forward: 0, strafe: 0, jump: false, sprint: true, climb: -1, detach: false, yaw: -Math.PI / 2 }
    });
    const descended = await waitForPlayer(
      socket,
      player.id,
      (state) => state.cling?.surfaceId === "center-red" && state.position.y < 1.38,
      "held Shift descent"
    );

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 2, forward: 0, strafe: 0, jump: false, sprint: false, climb: 0, detach: false, yaw: -Math.PI / 2 }
    });
    await delay(80);
    const released = latestPlayer(socket, player.id)!;
    await delay(80);
    const stopped = latestPlayer(socket, player.id)!;
    assert.equal(released.cling?.surfaceId, "center-red");
    assert.equal(stopped.cling?.surfaceId, "center-red");
    assert.ok(released.position.y <= descended.position.y);
    assert.ok(Math.abs(stopped.position.y - released.position.y) < 0.001);
    assert.ok(Math.abs(stopped.velocity.y) < 0.001);
  } finally {
    room.destroy();
  }
});

test("Space remains a normal jump when standing near a surface", async () => {
  const room = new GameRoom("JUMP01");
  try {
    const socket = new TestSocket();
    const player = room.addHuman(asWebSocket(socket), "Jumper");
    player.position = { x: DEPTH_CONTACT_X, y: 0, z: -1 };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.yaw = -Math.PI / 2;

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 1, forward: 0, strafe: 0, jump: true, sprint: false, climb: 0, detach: false, yaw: -Math.PI / 2 }
    });
    const jumped = await waitForPlayer(socket, player.id, (state) => state.position.y > 0.02, "normal jump near a surface");
    assert.equal(jumped.cling, undefined);
  } finally {
    room.destroy();
  }
});

test("malformed movement input cannot crash, detach, or poison later valid input", async () => {
  const room = new GameRoom("SAFE01");
  try {
    const socket = new TestSocket();
    const player = room.addHuman(asWebSocket(socket), "Safe Crawler");
    player.position = { x: DEPTH_CONTACT_X, y: 0.8, z: -1 };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.yaw = -Math.PI / 2;
    player.cling = { surfaceId: "center-red", normalX: -1, normalZ: 0 };

    const nullInput = { type: "input", input: null } as unknown as ClientMessage;
    assert.doesNotThrow(() => room.handleMessage(player.id, nullInput));
    const fractionalSequence = {
      type: "input",
      input: {
        sequence: 0.5,
        forward: 0,
        strafe: 0,
        jump: true,
        sprint: false,
        climb: 0,
        detach: false,
        yaw: -Math.PI / 2
      }
    } as unknown as ClientMessage;
    assert.doesNotThrow(() => room.handleMessage(player.id, fractionalSequence));
    const nonBooleanDetach = {
      type: "input",
      input: {
        sequence: 1,
        forward: 0,
        strafe: 0,
        jump: false,
        sprint: false,
        climb: 0,
        detach: "false",
        yaw: -Math.PI / 2
      }
    } as unknown as ClientMessage;
    assert.doesNotThrow(() => room.handleMessage(player.id, nonBooleanDetach));
    await delay(80);
    assert.equal(latestPlayer(socket, player.id)?.cling?.surfaceId, "center-red");

    room.handleMessage(player.id, {
      type: "input",
      input: { sequence: 2, forward: 1, strafe: 0, jump: false, sprint: false, climb: 0, detach: false, yaw: Math.PI / 2 }
    });
    await waitForPlayer(socket, player.id, (state) => !state.cling, "valid directional detach after malformed input");
  } finally {
    room.destroy();
  }
});
