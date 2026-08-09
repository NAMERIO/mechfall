import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { PROTOCOL_VERSION, type MatchmakeResponse } from "@mechfall/shared";
import { RoomManager } from "./matchmaking/RoomManager.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";
const app = express();
const server = createServer(app);
const rooms = new RoomManager();
const sockets = new WebSocketServer({ noServer: true, maxPayload: 16_384 });

app.disable("x-powered-by");
app.use(express.json({ limit: "4kb" }));

app.get("/health", (_request, response) => response.json({ ok: true }));
app.get("/api/status", (_request, response) => response.json({
  status: "online",
  players: rooms.playerCount,
  rooms: rooms.roomCount,
  protocol: PROTOCOL_VERSION
}));

app.post("/api/matchmake", (request, response) => {
  const { roomId, ticket } = rooms.matchmake();
  const forwardedProtocol = request.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const secure = forwardedProtocol ? forwardedProtocol === "https" : request.secure;
  const protocol = secure ? "wss" : "ws";
  const hostHeader = request.header("host") ?? `localhost:${port}`;
  const payload: MatchmakeResponse = {
    roomId,
    ticket,
    wsUrl: `${protocol}://${hostHeader}/play?room=${encodeURIComponent(roomId)}`,
    protocol: PROTOCOL_VERSION
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
  const roomId = url.searchParams.get("room") ?? "";
  sockets.handleUpgrade(request, socket, head, (webSocket) => {
    sockets.emit("connection", webSocket, roomId);
  });
});

sockets.on("connection", (socket, roomId: string) => {
  let playerId: string | undefined;
  let connectedRoom: ReturnType<RoomManager["consumeTicket"]>;
  const helloTimeout = setTimeout(() => socket.close(4001, "Hello timeout"), 5_000);

  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    const raw = data.toString();
    if (!playerId) {
      try {
        const hello = JSON.parse(raw) as { type?: string; protocol?: number; ticket?: string; name?: string };
        if (hello.type !== "hello" || hello.protocol !== PROTOCOL_VERSION || typeof hello.ticket !== "string") throw new Error("Bad hello");
        connectedRoom = rooms.consumeTicket(hello.ticket, roomId);
        if (!connectedRoom) throw new Error("Expired matchmaking ticket");
        const player = connectedRoom.addHuman(socket, String(hello.name ?? ""));
        playerId = player.id;
        clearTimeout(helloTimeout);
      } catch {
        socket.close(4002, "Invalid or expired ticket");
      }
      return;
    }
    connectedRoom?.handleMessage(playerId, raw);
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
