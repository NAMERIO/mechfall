import {
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage,
  type FindGameRequest,
  type FindGameMatchData,
  type FindGameResponse,
  type GameWsDisconnectReason,
  type OpenLobbyListResponse,
  type OpenLobbySummary,
  type ServerMessage
} from "@mechfall/shared";

type MessageHandler = (message: ServerMessage) => void;
type FindGameError = Extract<FindGameResponse, { type: "error" }>["error"];

export type MatchIntent =
  | { kind: "create" }
  | { kind: "join"; gameId: string };

export async function listOpenLobbies(): Promise<OpenLobbySummary[]> {
  const response = await fetch("/api/lobbies", { cache: "no-store", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Lobby directory unavailable (${response.status})`);

  const result = await response.json() as OpenLobbyListResponse;
  if (result.protocol !== PROTOCOL_VERSION) throw new Error("The game server is running a different protocol version.");
  if (!Array.isArray(result.lobbies)) throw new Error("The game server returned an invalid lobby list.");
  if (!result.lobbies.every(isOpenLobbySummary)) throw new Error("The game server returned an invalid lobby list.");
  return result.lobbies;
}

export class GameConnection {
  private socket?: WebSocket;
  private pingTimer?: number;
  private matchRequest?: AbortController;
  private handler: MessageHandler;
  latency = 0;

  constructor(handler: MessageHandler) {
    this.handler = handler;
  }

  async connect(name: string, intent: MatchIntent): Promise<FindGameMatchData> {
    if (this.socket || this.matchRequest) throw new Error("A connection is already in progress.");
    const request: FindGameRequest = intent.kind === "create"
      ? { protocol: PROTOCOL_VERSION, create: true }
      : { protocol: PROTOCOL_VERSION, gameId: intent.gameId.trim().toUpperCase() };
    const matchRequest = new AbortController();
    this.matchRequest = matchRequest;
    let response: Response;
    try {
      response = await fetch("/api/find_game", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: matchRequest.signal
      });
    } finally {
      if (this.matchRequest === matchRequest) this.matchRequest = undefined;
    }
    if (!response.ok) throw new Error(`Matchmaking failed (${response.status})`);
    const result = await response.json() as FindGameResponse;
    if (result.type === "error") throw new Error(findGameErrorMessage(result.error));
    const match = result.res;
    if (match.protocol !== PROTOCOL_VERSION) throw new Error("The game server is running a different protocol version.");
    const rawUrl = match.urls[0];
    if (!rawUrl) throw new Error("The game server did not return a play URL.");
    const wsUrl = new URL(rawUrl);
    if (window.location.protocol === "https:" && wsUrl.protocol === "ws:") wsUrl.protocol = "wss:";

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      let welcomed = false;
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (error) {
          if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close(1000, "Connection cancelled");
          if (this.socket === socket) this.socket = undefined;
          reject(error);
        } else {
          resolve();
        }
      };
      const timeout = window.setTimeout(() => finish(new Error("Connection timed out")), 8_000);
      socket.addEventListener("open", () => {
        this.send({ type: "hello", protocol: PROTOCOL_VERSION, name, ticket: match.ticket });
      });
      socket.addEventListener("message", (event) => {
        if (!(event.data instanceof ArrayBuffer)) {
          socket.close(4000, "invalid_packet");
          return;
        }
        const message = decodeServerMessage(event.data);
        if (!message) {
          socket.close(4000, "invalid_packet");
          return;
        }
        if (message.type === "welcome") {
          if (message.protocol !== PROTOCOL_VERSION || message.gameId !== match.gameId) {
            socket.close(4000, "invalid_protocol");
            return;
          }
          welcomed = true;
          finish();
        }
        if (message.type === "pong") this.latency = Math.max(0, Math.round((performance.timeOrigin + performance.now() - message.sentAt) / 2));
        this.handler(message);
      });
      socket.addEventListener("error", () => finish(new Error("Could not reach the game server")));
      socket.addEventListener("close", (event) => {
        window.clearTimeout(timeout);
        window.clearInterval(this.pingTimer);
        if (this.socket === socket) this.socket = undefined;
        const message = disconnectMessage(event.reason as GameWsDisconnectReason);
        if (!welcomed) finish(new Error(message));
        else if (event.code !== 1000) this.handler({ type: "error", code: "disconnected", message });
      });
    });

    this.pingTimer = window.setInterval(() => this.send({ type: "ping", sentAt: performance.timeOrigin + performance.now() }), 2_000);
    return match;
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encodeClientMessage(message));
  }

  close(): void {
    this.matchRequest?.abort();
    this.matchRequest = undefined;
    window.clearInterval(this.pingTimer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "Client left");
  }
}

function isOpenLobbySummary(value: unknown): value is OpenLobbySummary {
  if (!value || typeof value !== "object") return false;
  const lobby = value as Partial<OpenLobbySummary>;
  return typeof lobby.gameId === "string"
    && /^[A-Z0-9]{6}$/.test(lobby.gameId)
    && typeof lobby.ownerName === "string"
    && lobby.ownerName.length > 0
    && lobby.ownerName.length <= 18
    && Number.isSafeInteger(lobby.playerCount)
    && Number.isSafeInteger(lobby.maxPlayers)
    && Number(lobby.playerCount) > 0
    && Number(lobby.maxPlayers) >= Number(lobby.playerCount);
}

function findGameErrorMessage(error: FindGameError): string {
  if (error === "full") return "That lobby just filled up. Choose another one.";
  if (error === "invalid_game_id") return "That lobby is no longer available.";
  if (error === "invalid_request") return "The server rejected that lobby request.";
  if (error === "not_joinable") return "That lobby has already started. Choose another one.";
  if (error === "server_busy") return "The server is busy creating lobbies. Try again shortly.";
  return "The client and server protocol versions do not match.";
}

function disconnectMessage(reason: GameWsDisconnectReason | string): string {
  const messages: Partial<Record<GameWsDisconnectReason, string>> = {
    game_not_found: "That game no longer exists.",
    game_full: "That game filled up before you connected.",
    invalid_packet: "The server rejected an invalid network packet.",
    invalid_protocol: "The client and server protocol versions do not match.",
    invalid_ticket: "Your join ticket expired. Try joining again.",
    rate_limited: "Too many network packets were sent.",
    server_restart: "The game server restarted."
  };
  return messages[reason as GameWsDisconnectReason] ?? "Connection to the game was lost.";
}
