import {
  PROTOCOL_VERSION,
  type FindGameMatchData,
  type FindGameRequest,
  type FindGameResponse,
  type OpenLobbyListResponse,
  type OpenLobbySummary
} from "@mechfall/shared";
import type { BotConfig } from "./config.ts";

export class LobbyCoordinator {
  private preferredGameId?: string;
  private lastWaitingLog = 0;
  private stopped = false;

  constructor(private readonly config: BotConfig) {
    this.preferredGameId = config.gameId;
  }

  async findMatch(botName: string): Promise<FindGameMatchData> {
    while (!this.stopped) {
      try {
        const request = await this.chooseRequest();
        if (!request) {
          this.logWaiting(botName);
          await delay(this.config.retryDelayMs);
          continue;
        }
        const response = await fetch(`${this.config.serverUrl}/api/find_game`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(request)
        });
        if (!response.ok) throw new Error(`matchmaking returned HTTP ${response.status}`);
        const result = await response.json() as FindGameResponse;
        if (result.type === "success") {
          this.preferredGameId = result.res.gameId;
          return result.res;
        }
        if (!this.config.gameId && (result.error === "full" || result.error === "not_joinable" || result.error === "invalid_game_id")) {
          this.preferredGameId = undefined;
        }
        console.warn(`[${botName}] lobby unavailable (${result.error}); retrying`);
      } catch (error) {
        console.warn(`[${botName}] ${errorMessage(error)}; retrying`);
      }
      await delay(this.config.retryDelayMs);
    }
    throw new Error("matchmaking stopped");
  }

  forget(gameId: string): void {
    if (!this.config.gameId && this.preferredGameId === gameId) this.preferredGameId = undefined;
  }

  stop(): void {
    this.stopped = true;
  }

  private async chooseRequest(): Promise<FindGameRequest | undefined> {
    if (this.config.gameId) return { protocol: PROTOCOL_VERSION, gameId: this.config.gameId };
    if (this.preferredGameId) return { protocol: PROTOCOL_VERSION, gameId: this.preferredGameId };
    if (this.config.createLobby) return { protocol: PROTOCOL_VERSION, create: true };
    const lobbies = await this.listLobbies();
    const lobby = lobbies
      .filter((candidate) => candidate.playerCount < candidate.maxPlayers)
      .sort((left, right) => right.playerCount - left.playerCount || left.gameId.localeCompare(right.gameId))[0];
    if (!lobby) return undefined;
    this.preferredGameId = lobby.gameId;
    return { protocol: PROTOCOL_VERSION, gameId: lobby.gameId };
  }

  private async listLobbies(): Promise<OpenLobbySummary[]> {
    const response = await fetch(`${this.config.serverUrl}/api/lobbies`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`lobby directory returned HTTP ${response.status}`);
    const result = await response.json() as OpenLobbyListResponse;
    if (result.protocol !== PROTOCOL_VERSION || !Array.isArray(result.lobbies)) throw new Error("lobby directory protocol mismatch");
    return result.lobbies;
  }

  private logWaiting(botName: string): void {
    const now = Date.now();
    if (now - this.lastWaitingLog < 10_000) return;
    this.lastWaitingLog = now;
    console.log(`[${botName}] no open lobby yet; waiting`);
  }
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
