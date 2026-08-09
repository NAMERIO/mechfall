import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import {
  PROTOCOL_VERSION,
  MAX_GAME_PACKET_BYTES,
  decodeClientMessage,
  type FindGameResponse,
  type GameWsDisconnectReason
} from "@mechfall/shared";
import { RoomManager } from "./matchmaking/RoomManager.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";
const app = express();
const server = createServer(app);
const rooms = new RoomManager();
const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_GAME_PACKET_BYTES });

app.disable("x-powered-by");
app.use(express.json({ limit: "4kb" }));

app.get("/health", (_request, response) => response.json({ ok: true }));
app.get("/api/status", (_request, response) => response.json({
  status: "online",
  players: rooms.playerCount,
  games: rooms.roomCount,
  protocol: PROTOCOL_VERSION
}));

app.post(["/api/find_game", "/api/matchmake"], (request, response) => {
  if (Number(request.body?.protocol) !== PROTOCOL_VERSION) {
    const payload: FindGameResponse = { type: "error", error: "invalid_protocol" };
    response.json(payload);
    return;
  }
  const result = rooms.findGame(typeof request.body?.gameId === "string" ? request.body.gameId : undefined);
  if ("error" in result) {
    const payload: FindGameResponse = { type: "error", error: result.error };
    response.json(payload);
    return;
  }
  const forwardedProtocol = request.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const secure = forwardedProtocol ? forwardedProtocol === "https" : request.secure;
  const protocol = secure ? "wss" : "ws";
  const hostHeader = request.header("host") ?? `localhost:${port}`;
  const playUrl = new URL(`${protocol}://${hostHeader}/play`);
  playUrl.searchParams.set("gameId", result.gameId);
  const payload: FindGameResponse = {
    type: "success",
    res: {
      gameId: result.gameId,
      ticket: result.ticket,
      urls: [playUrl.toString()],
      protocol: PROTOCOL_VERSION
    }
  };
  response.json(payload);
});

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(currentDir, "../../client/dist");
if (existsSync(clientDist)) {
  app.use(express.static(clientDist, { maxAge: "1h" }));
  app.get("/{*path}", (_request, response) => response.sendFile(path.join(clientDist, "index.html")));
}

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname !== "/play") {
    socket.destroy();
    return;
  }
  const gameId = url.searchParams.get("gameId")?.toUpperCase() ?? "";
  if (!rooms.hasGame(gameId)) {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (webSocket) => {
    sockets.emit("connection", webSocket, gameId);
  });
});

sockets.on("connection", (socket, gameId: string) => {
  let playerId: string | undefined;
  let connectedRoom: ReturnType<RoomManager["consumeTicket"]>;
  let rateWindowStartedAt = Date.now();
  let messagesInWindow = 0;
  const disconnect = (reason: GameWsDisconnectReason): void => socket.close(4000, reason);
  const helloTimeout = setTimeout(() => disconnect("invalid_ticket"), 5_000);

  socket.on("message", (data, isBinary) => {
    if (!isBinary) {
      disconnect("invalid_packet");
      return;
    }
    const now = Date.now();
    if (now - rateWindowStartedAt >= 1_000) {
      rateWindowStartedAt = now;
      messagesInWindow = 0;
    }
    messagesInWindow += 1;
    if (messagesInWindow > 180) {
      disconnect("rate_limited");
      return;
    }
    const packet = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer
        ? data
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const message = decodeClientMessage(packet);
    if (!message) {
      disconnect("invalid_packet");
      return;
    }
    if (!playerId) {
      if (message.type !== "hello" || typeof message.ticket !== "string") {
        disconnect("invalid_packet");
        return;
      }
      if (message.protocol !== PROTOCOL_VERSION) {
        disconnect("invalid_protocol");
        return;
      }
      connectedRoom = rooms.consumeTicket(message.ticket, gameId);
      if (!connectedRoom) {
        disconnect("invalid_ticket");
        return;
      }
      if (connectedRoom.full) {
        disconnect("game_full");
        return;
      }
      const player = connectedRoom.addHuman(socket, String(message.name ?? ""));
      playerId = player.id;
      clearTimeout(helloTimeout);
      return;
    }
    if (message.type === "hello") {
      disconnect("invalid_packet");
      return;
    }
    connectedRoom?.handleMessage(playerId, message);
  });

  socket.on("close", () => {
    clearTimeout(helloTimeout);
    if (playerId) connectedRoom?.removeHuman(playerId);
  });
  socket.on("error", () => {
    clearTimeout(helloTimeout);
    if (playerId) connectedRoom?.removeHuman(playerId);
  });
});

server.listen(port, host, () => {
  console.log(`MECHFALL server listening on http://${host}:${port}`);
});

function shutdown(): void {
  rooms.close();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
