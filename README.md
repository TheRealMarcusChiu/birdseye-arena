# Birdseye Arena

Top-down multiplayer shooter. Up to 8 players per room over WebRTC P2P.

## Controls

| Action | Key / Input |
|--------|-------------|
| Move | WASD or Arrow keys |
| Aim | Mouse cursor |
| Shoot | Hold Left Mouse Button |
| Weapon 1 — Pistol | `1` or scroll |
| Weapon 2 — Rifle | `2` or scroll |
| Weapon 3 — Shotgun | `3` or scroll |

## Architecture

- **Host/guest model** — the player who creates a room runs the authoritative `GameEngine` simulation (50 ms ticks). Guests send input messages; the host ticks the world and broadcasts state snapshots.
- **WebRTC P2P** via [PeerJS](https://peerjs.com). A signaling server (public PeerJS cloud or local `peer` npm package) brokers the initial ICE exchange; after that all game traffic is direct peer-to-peer.
- **Game engine** (`engine.js`) is pure JavaScript with no DOM dependencies — unit-tested with Node's built-in test runner.
- **Serialization** — all wire messages are `JSON.stringify`/`JSON.parse`. Guest input messages are limited to 8 KB; host state snapshots are limited to 256 KB (a full 8-player + 512-bullet world is ~60 KB).
- **Rate limiting** — host drops connections sending more than 90 input messages/second (well above the normal 30/s guest loop).
- **Bullet cap** — engine hard-caps active bullets at 512 to bound serialized state size.

### Public signaling / NAT limitations

The default E2E tests use the public PeerJS cloud signaling server (`0.peerjs.com`). This requires:

- Outbound HTTPS (port 443) to `0.peerjs.com` from the test runner.
- Successful ICE negotiation. On most networks (home, office, CI with direct egress) STUN-only NAT traversal succeeds. Symmetric NAT or strict corporate firewalls can block the WebRTC data channel.

`SIGNAL=local` only changes **where peers discover each other** (signaling / ICE exchange). It does not relay game traffic. Two peers behind different restrictive NATs (e.g. symmetric NAT) that cannot punch through will still fail to connect even with a local signal server. True cross-network restrictive NAT requires a TURN relay server, which this project does not provision. Same-machine testing (two tabs on one computer) is not cross-NAT proof.

Room codes are 4 random uppercase letters prefixed with `birdseye-arena-v1-` on the signaling server. Up to 12 automatic retries if a code is already taken.

## Running

Install dependencies first:

```sh
npm ci
```

Serve `index.html` with any static HTTP server (required for ES module imports):

```sh
npx serve .
# or
python3 -m http.server 8080
```

Open `http://localhost:8080` in two browser tabs. One tab creates a room; the other joins with the 4-letter code.

**Notes:**
- The host tab must remain open. Closing it ends the room for all connected players.
- Controls require a keyboard and mouse (desktop). Touch/mobile is not supported.
- Testing with two tabs on the same machine is not cross-NAT proof — see NAT limitations above.

## Tests

### Unit tests (engine)

```sh
npm ci
npm test
```

Runs unit tests against the pure simulation logic. No browser required.

### End-to-end tests

Requires dependencies and Chromium:

```sh
npm ci
npx playwright install chromium
```

Run with public PeerJS signaling (default — requires internet):

```sh
npm run test:e2e
```

Run with local signaling server (no internet required, faster):

```sh
SIGNAL=local npm run test:e2e
```

Run against a deployed URL:

```sh
BASE_URL=https://your-site.example.com npm run test:e2e
```

The E2E suite covers: room creation, guest join, movement sync, weapon switch, shooting, malicious input rejection, late-join snapshot, room-code collision retry, guest leave, host-end disconnect, room recreation, and sustained input rate (6 s continuous input without disconnection).
