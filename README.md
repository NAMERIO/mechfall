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

Open <http://localhost:5173>. The game server runs on port `3001`.

To run either package separately:

```sh
pnpm --filter @mechfall/client dev
pnpm --filter @mechfall/server dev
```

Three server-controlled bots are added to each room so local matches can be tested with one browser. Open another browser tab to test multiplayer.

### Checks

```sh
pnpm typecheck
pnpm test
pnpm build
```

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

## Disclaimer

MECHFALL is an independent prototype inspired by paint based hide and-seek games. It is not affiliated with or endorsed by the developers of *Meccha Chameleon*.
