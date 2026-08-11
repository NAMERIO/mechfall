export interface BotConfig {
  serverUrl: string;
  count: number;
  gameId?: string;
  createLobby: boolean;
  autoStart: boolean;
  namePrefix: string;
  joinDelayMs: number;
  retryDelayMs: number;
}

export function readConfig(args = process.argv.slice(2), environment = process.env): BotConfig {
  const flags = parseFlags(args);
  const serverUrl = String(flags.get("server") ?? environment.BOT_SERVER_URL ?? "http://localhost:3001").replace(/\/+$/, "");
  const parsedUrl = new URL(serverUrl);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("Bot server must use http:// or https://");
  const gameIdValue = String(flags.get("game") ?? environment.BOT_GAME_ID ?? "").trim().toUpperCase();
  if (gameIdValue && !/^[A-Z0-9]{6}$/.test(gameIdValue)) throw new Error("Bot game ID must contain exactly six letters or digits");
  return {
    serverUrl,
    count: boundedInteger(flags.get("count") ?? environment.BOT_COUNT ?? 1, "bot count", 1, 12),
    gameId: gameIdValue || undefined,
    createLobby: booleanValue(flags.get("create") ?? environment.BOT_CREATE_LOBBY, false),
    autoStart: booleanValue(flags.get("auto-start") ?? environment.BOT_AUTO_START, false),
    namePrefix: String(flags.get("name") ?? environment.BOT_NAME_PREFIX ?? "MF Bot").replace(/[^a-z0-9 _-]/gi, "").trim().slice(0, 13) || "MF Bot",
    joinDelayMs: boundedInteger(environment.BOT_JOIN_DELAY_MS ?? 350, "join delay", 50, 10_000),
    retryDelayMs: boundedInteger(environment.BOT_RETRY_DELAY_MS ?? 2_500, "retry delay", 250, 60_000)
  };
}

function parseFlags(args: string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) continue;
    const equals = argument.indexOf("=");
    if (equals >= 0) {
      flags.set(argument.slice(2, equals), argument.slice(equals + 1));
      continue;
    }
    const key = argument.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  return flags;
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Expected a boolean, received ${String(value)}`);
}
