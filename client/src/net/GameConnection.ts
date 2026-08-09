import { PROTOCOL_VERSION, type ClientMessage, type MatchmakeResponse, type ServerMessage } from "@mechfall/shared";

type MessageHandler = (message: ServerMessage) => void;

export class GameConnection {
  private socket?: WebSocket;
  private pingTimer?: number;
  private handler: MessageHandler;
  latency = 0;

  constructor(handler: MessageHandler) {
    this.handler = handler;
  }

  async connect(name: string): Promise<MatchmakeResponse> {
    const response = await fetch("/api/matchmake", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!response.ok) throw new Error(`Matchmaking failed (${response.status})`);
    const match = await response.json() as MatchmakeResponse;
    const wsUrl = new URL(match.wsUrl);
    if (wsUrl.host !== window.location.host) wsUrl.host = window.location.host;
    wsUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      this.socket = socket;
      const timeout = window.setTimeout(() => reject(new Error("Connection timed out")), 8_000);
      socket.addEventListener("open", () => {
        this.send({ type: "hello", protocol: PROTOCOL_VERSION, name, ticket: match.ticket });
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type === "welcome") {
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
        if (!event.wasClean) this.handler({ type: "error", code: "disconnected", message: "Connection to the room was lost." });
      });
    });

    this.pingTimer = window.setInterval(() => this.send({ type: "ping", sentAt: performance.timeOrigin + performance.now() }), 2_000);
    return match;
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  close(): void {
    window.clearInterval(this.pingTimer);
    this.socket?.close(1000, "Client left");
  }
}
