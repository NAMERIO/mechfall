import { SmartBot } from "./SmartBot.ts";
import { readConfig } from "./config.ts";
import { LobbyCoordinator, delay, errorMessage } from "./matchmaking.ts";
import { NavigationMap } from "./navigation.ts";

const config = readConfig();
const navigation = new NavigationMap();
const coordinator = new LobbyCoordinator(config);
const bots: SmartBot[] = [];
let stopping = false;

console.log(`MECHFALL bots ready · ${config.count} bot${config.count === 1 ? "" : "s"} · ${config.serverUrl}`);
if (config.gameId) console.log(`Target lobby: ${config.gameId}`);
else if (config.createLobby) console.log("Bots will create and share a lobby");
else console.log("Bots will join the fullest open lobby and wait for its owner");

for (let index = 1; index <= config.count && !stopping; index += 1) {
  const name = `${config.namePrefix} ${index}`.slice(0, 18);
  const bot = new SmartBot(index, name, config, navigation);
  bots.push(bot);
  void runBot(bot);
  await delay(config.joinDelayMs);
}

async function runBot(bot: SmartBot): Promise<void> {
  while (!stopping) {
    try {
      const match = await coordinator.findMatch(bot.name);
      await bot.play(match);
      coordinator.forget(match.gameId);
    } catch (error) {
      console.warn(`[${bot.name}] ${errorMessage(error)}`);
    }
    if (!stopping) await delay(config.retryDelayMs);
  }
}

function shutdown(): void {
  if (stopping) return;
  stopping = true;
  console.log("Stopping bots…");
  coordinator.stop();
  for (const bot of bots) bot.stop();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
