<div align="center">
    <h1>MECHFALL</h1>
</div>
<hr />
<div align="center">
    <img src="https://img.shields.io/badge/node.js-%235FA04E.svg?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js">
    <img src="https://img.shields.io/badge/typescript-%233178C6.svg?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/three.js-%23000000.svg?style=for-the-badge&logo=threedotjs&logoColor=white" alt="Three.js">
    <img src="https://img.shields.io/badge/vite-%23646CFF.svg?style=for-the-badge&logo=vite&logoColor=white" alt="Vite">
    <img src="https://img.shields.io/badge/websockets-%23010101.svg?style=for-the-badge&logo=socketdotio&logoColor=white" alt="WebSockets">
</div>
<br />
<div align="center">
    Multiplayer 3D hide-and-seek game where hiders paint themselves to blend into the map.
</div>
<br />

## Development

Install [Node.js 22+](https://nodejs.org) and [pnpm 11+](https://pnpm.io), then install the workspace dependencies:

```sh
pnpm install
```

Start the client and game server together:

```sh
pnpm dev
```

Open <http://localhost:3000>. The game server runs on port `3001`.

To run either package separately:

```sh
pnpm --filter @mechfall/client dev
pnpm --filter @mechfall/server dev
```

A game needs at least two connected players; the first player is the owner and chooses when to start. If the owner leaves, ownership transfers to the next connected player. Open another browser tab and enter the same six-character game ID to test multiplayer locally.

Headless gameplay bots are a separate workspace package. They join the fullest open lobby and wait for its owner by default:

```sh
pnpm bots -- --count 3
```

They roam the lobby, navigate the bunker and its doors, pick hiding places, camouflage themselves against nearby surfaces, and hunt when assigned that role. See [bots/README.md](bots/README.md) for lobby targeting, auto-start, and server options.

Leave the **GAME ID** field empty to find a public game. Enter an existing ID to join that exact game, or share the generated `?gameId=ABC123` URL. Clicking the game ID in the HUD copies it.

### Multiplayer protocol

The networking layout follows the same broad flow as Survev:

1. `POST /api/find_game` validates the protocol and returns `{ gameId, ticket, urls }`.
2. The client opens `/play?gameId=...` and sends the ticket in its first WebSocket packet.
3. WebSocket messages are binary frames beginning with a stable one-byte packet type from `shared/src/net/packets.ts`.
4. The server owns movement, rounds, roles, painting, shotgun hits, scores, and snapshots for each isolated game.

Join tickets expire after 30 seconds and can only be consumed once. Unknown game IDs, protocol mismatches, text frames, forged packet IDs, and excessive message rates are rejected by the server.

### Checks

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

### Blender compound collision tool

For detailed house/interior GLBs, use the [automatic Blender compound-collider generator](tools/blender/README.md). It creates lightweight box, cylinder, and convex colliders while skipping small decoration and leaving doors open by default.

## Production

Build the client and server:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

The production server hosts the built client and accepts these environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Address the server listens on |
| `PORT` | `3001` | HTTP and WebSocket port |

Put the server behind an HTTPS reverse proxy for public hosting so browsers connect over secure WebSockets.

## Licensed assets

The player character uses [Chameleon Man Pro (Meccha Man)](https://www.fab.com/listings/735aec34-4949-465c-ad93-848d235996bb) by StuffKit under the [Fab Standard License](https://www.fab.com/eula). Asset details and project modifications are recorded in [client/public/models/ATTRIBUTION.md](client/public/models/ATTRIBUTION.md).

## Disclaimer

MECHFALL is an independent prototype inspired by paint based hide and-seek games. It is not affiliated with or endorsed by the developers of *Meccha Chameleon*.
