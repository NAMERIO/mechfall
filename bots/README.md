# MECHFALL gameplay bots

This workspace package runs real headless game clients. It follows the same matchmaking and binary WebSocket flow as the browser client, then uses server snapshots to make role-aware decisions.

From the repository root, start the game normally and run:

```sh
pnpm bots
```

By default one bot waits for the fullest public lobby, joins it, roams during the lobby, and waits for the human owner to start. Start several bots or target one lobby with:

```sh
pnpm bots -- --count 4
pnpm bots -- --count 3 --game ABC123
```

For a bot-owned test lobby that starts as soon as two clients have joined:

```sh
pnpm bots -- --count 4 --create --auto-start
```

Options can also be set with environment variables:

| CLI | Environment | Default | Meaning |
| --- | --- | --- | --- |
| `--server URL` | `BOT_SERVER_URL` | `http://localhost:3001` | HTTP game-server origin |
| `--count N` | `BOT_COUNT` | `1` | Number of bot clients, up to 12 |
| `--game ID` | `BOT_GAME_ID` | unset | Join one six-character lobby |
| `--create` | `BOT_CREATE_LOBBY` | `false` | Create a lobby when no target is selected |
| `--auto-start` | `BOT_AUTO_START` | `false` | Start when a bot owns a lobby with enough players |
| `--name PREFIX` | `BOT_NAME_PREFIX` | `MF Bot` | Player-name prefix |

The bunker navigator reads the same compound-collider manifest as the server. It builds an inflated A* grid, preserves the five authored door clearances, selects covered hiding cells away from hunters, and samples a matching material-family color near the final spot. Hiders paint every body part, select a pose, stay still once hidden, and flee when a hunter gets close. Hunters route toward reachable hiders, aim, and fire only when the navigation line of sight is clear.
