import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_VERSION,
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

test("websocket decoder rejects a payload with a forged type byte", () => {
  const packet = encodeClientMessage({ type: "ping", sentAt: 123 });
  packet[0] = WsPacketType.Shoot;
  assert.equal(decodeClientMessage(packet), undefined);
});

test("server packets round-trip through the shared binary codec", () => {
  const message: ServerMessage = { type: "welcome", id: "player", gameId: "ABC123", protocol: PROTOCOL_VERSION };
  assert.deepEqual(decodeServerMessage(encodeServerMessage(message)), message);
});
