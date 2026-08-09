import {
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage,
  type FindGameMatchData,
  type FindGameResponse,
  type GameWsDisconnectReason,
  type ServerMessage
} from "@mechfall/shared";

type MessageHandler = (message: ServerMessage) => void;
type FindGameError = Extract<FindGameResponse, { type: "error" }>["error"];

export class GameConnection {
  private socket?: WebSocket;
  private pingTimer?: number;
  private handler: MessageHandler;
  latency = 0;

  constructor(handler: MessageHandler) {
    this.handler = handler;
  }

  async connect(name: string, requestedGameId?: string): Promise<FindGameMatchData> {
    const response = await fetch("/api/find_game", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocol: PROTOCOL_VERSION, gameId: requestedGameId?.trim().toUpperCase() || undefined })
    });
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
      const timeout = window.setTimeout(() => reject(new Error("Connection timed out")), 8_000);
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
          window.clearTimeout(timeout);
          resolve();
        }
        if (message.type === "pong") this.latency = Math.max(0, Math.round((performance.timeOrigin + performance.now() - message.sentAt) / 2));
        this.handler(message);
      });
      socket.addEventListener("error", () => reject(new Error("Could not reach the game server")));
      socket.addEventListener("close", (event) => {
        window.clearTimeout(timeout);
        window.clearInterval(this.pingTimer);
        const message = disconnectMessage(event.reason as GameWsDisconnectReason);
        if (!welcomed) reject(new Error(message));
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
    window.clearInterval(this.pingTimer);
    this.socket?.close(1000, "Client left");
  }
}

function findGameErrorMessage(error: FindGameError): string {
  if (error === "full") return "That game is full.";
  if (error === "invalid_game_id") return "That game ID does not exist.";
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
