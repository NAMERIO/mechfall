import type { ClientMessage, ServerMessage } from "./protocol.ts";

// Stable one-byte packet identifiers, following Survev's MsgType framing.
// Never reorder existing values; append new packet types instead.
export enum WsPacketType {
  None = 0,
  Hello = 1,
  Input = 2,
  PaintStroke = 3,
  PaintStrokes = 4,
  ClearPaint = 5,
  Pose = 6,
  Shoot = 7,
  Whistle = 8,
  Ping = 9,

  Welcome = 64,
  Snapshot = 65,
  Pong = 66,
  PaintState = 67,
  PaintReset = 68,
  Error = 69
}

const CLIENT_PACKET_TYPES: Record<ClientMessage["type"], WsPacketType> = {
  hello: WsPacketType.Hello,
  input: WsPacketType.Input,
  paintStroke: WsPacketType.PaintStroke,
  paintStrokes: WsPacketType.PaintStrokes,
  clearPaint: WsPacketType.ClearPaint,
  pose: WsPacketType.Pose,
  shoot: WsPacketType.Shoot,
  whistle: WsPacketType.Whistle,
  ping: WsPacketType.Ping
};

const SERVER_PACKET_TYPES: Record<ServerMessage["type"], WsPacketType> = {
  welcome: WsPacketType.Welcome,
  snapshot: WsPacketType.Snapshot,
  pong: WsPacketType.Pong,
  paintStroke: WsPacketType.PaintStroke,
  paintStrokes: WsPacketType.PaintStrokes,
  paintState: WsPacketType.PaintState,
  paintReset: WsPacketType.PaintReset,
  error: WsPacketType.Error
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeClientMessage(message: ClientMessage): Uint8Array {
  return encodePacket(CLIENT_PACKET_TYPES[message.type], message);
}

export function encodeServerMessage(message: ServerMessage): Uint8Array {
  return encodePacket(SERVER_PACKET_TYPES[message.type], message);
}

export function decodeClientMessage(data: ArrayBuffer | Uint8Array): ClientMessage | undefined {
  return decodePacket(data, CLIENT_PACKET_TYPES);
}

export function decodeServerMessage(data: ArrayBuffer | Uint8Array): ServerMessage | undefined {
  return decodePacket(data, SERVER_PACKET_TYPES);
}

function encodePacket(type: WsPacketType, message: ClientMessage | ServerMessage): Uint8Array {
  const payload = encoder.encode(JSON.stringify(message));
  const packet = new Uint8Array(payload.length + 1);
  packet[0] = type;
  packet.set(payload, 1);
  return packet;
}

function decodePacket<T extends ClientMessage | ServerMessage>(
  data: ArrayBuffer | Uint8Array,
  packetTypes: Partial<Record<string, WsPacketType>>
): T | undefined {
  const packet = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (packet.length < 2) return undefined;
  try {
    const message = JSON.parse(decoder.decode(packet.subarray(1))) as T;
    if (!message || typeof message !== "object" || typeof message.type !== "string") return undefined;
    if (packetTypes[message.type] !== packet[0]) return undefined;
    return message;
  } catch {
    return undefined;
  }
}
