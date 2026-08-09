import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_VERSION,
  MAX_GAME_PACKET_BYTES,
  MAX_PAINT_STROKES_PER_PACKET,
  WsPacketType,
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  type ServerMessage
} from "@mechfall/shared";

test("websocket packets use a stable leading message type", () => {
  const hello = { type: "hello", protocol: PROTOCOL_VERSION, name: "Tester", ticket: "ticket" } as const;
  const packet = encodeClientMessage(hello);
  assert.equal(packet[0], WsPacketType.Hello);
  assert.deepEqual(decodeClientMessage(packet), hello);
});

test("wall movement intent round-trips through the multiplayer codec", () => {
  const input = {
    type: "input",
    input: {
      sequence: 42,
      forward: 0,
      strafe: 1,
      jump: false,
      sprint: true,
      climb: -1,
      detach: false,
      yaw: Math.PI / 2
    }
  } as const;
  assert.deepEqual(decodeClientMessage(encodeClientMessage(input)), input);
});

test("websocket decoder rejects a payload with a forged type byte", () => {
  const packet = encodeClientMessage({ type: "ping", sentAt: 123 });
  packet[0] = WsPacketType.Shoot;
  assert.equal(decodeClientMessage(packet), undefined);
});

test("server packets round-trip through the shared binary codec", () => {
  const message: ServerMessage = { type: "welcome", id: "player", gameId: "ABC123", protocol: PROTOCOL_VERSION };
  assert.deepEqual(decodeServerMessage(encodeServerMessage(message)), message);
});

test("projected face brush strokes round-trip through the multiplayer codec", () => {
  const message: ServerMessage = {
    type: "paintStroke",
    playerId: "player",
    stroke: {
      part: "body",
      u: 0.3,
      v: 0.7,
      face: 481,
      brushUx: 0.04,
      brushVx: -0.01,
      brushUy: 0.005,
      brushVy: 0.03,
      brushEndU: 0.42,
      brushEndV: 0.72,
      color: "#35d6c7",
      size: 0.07
    }
  };
  assert.deepEqual(decodeServerMessage(encodeServerMessage(message)), message);
});

test("a full projected paint batch stays below the WebSocket payload limit", () => {
  const stroke = {
    part: "body",
    u: 0.123456,
    v: 0.654321,
    face: 2_847,
    brushUx: 0.012345,
    brushVx: -0.012345,
    brushUy: 0.023456,
    brushVy: -0.023456,
    brushEndU: 0.876543,
    brushEndV: 0.765432,
    color: "#35d6c7",
    size: 0.12
  } as const;
  const packet = encodeClientMessage({
    type: "paintStrokes",
    strokes: Array.from({ length: MAX_PAINT_STROKES_PER_PACKET }, () => ({ ...stroke }))
  });
  assert.ok(packet.byteLength < MAX_GAME_PACKET_BYTES, `${packet.byteLength} byte paint packet exceeds server limit`);
});
