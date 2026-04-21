# Deliveroo.js SDK — API Reference

Consolidated reference for `@unitn-asa/deliveroo-js-sdk`. Based on the official course handout; cross-check against the SDK source at https://github.com/unitn-ASA/Deliveroo.js/tree/master/packages if behavior is surprising.

## Contents

- [Install and connect](#install-and-connect)
- [Two clients: Socket and REST](#two-clients-socket-and-rest)
- [Actions](#actions)
- [Events (listeners)](#events-listeners)
- [Type shapes](#type-shapes)
- [REST endpoints (admin)](#rest-endpoints-admin)
- [Minimal working example](#minimal-working-example)
- [Keyboard controls (for debugging via the 3D client)](#keyboard-controls-for-debugging-via-the-3d-client)

## Install and connect

```bash
npm init -y
npm install @unitn-asa/deliveroo-js-sdk
```

```js
import { DjsConnect, DjsClientSocket } from "@unitn-asa/deliveroo-js-sdk/client";

const socket = DjsConnect('localhost:8080', 'YOUR_TOKEN');
```

Or via env:

```
# .env
HOST=localhost:8080
TOKEN=your_token_here
# alternatively, auto-provision a token by name:
# NAME=MyAgentName
```

The course materials show `DjsConnect('localhost:8080', 'YOUR_TOKEN')` with two positional args. The SDK also accepts an options object form — if a single-string form errors, check the SDK version and adapt.

## Two clients: Socket and REST

```
DjsConnect
│
├─→ DjsClientSocket (WebSocket)
│   ├─ Game actions (emitMove, emitPickup, emitPutdown, …)
│   └─ Event listeners (sensing streams, messages)
│
└─→ DjsRestClient (HTTP)
    └─ Admin operations (manage agents, parcels, tokens, configs)
```

For normal gameplay, only the socket matters. REST is for admin/orchestration tasks (spawning parcels programmatically, managing configs, etc.).

## Actions

All actions are `async` and return a truthy result on success, falsy on failure.

```js
// Move. Directions: 'up', 'down', 'left', 'right'.
// Returns {x, y} on success (the destination tile), false on failure.
const result = await socket.emitMove('up');

// Pickup. Picks up all parcels on the agent's current tile.
// Returns an array of picked-up parcel objects.
const parcels = await socket.emitPickup();
// [{ id, x, y, carriedBy, reward }, ...]

// Putdown. Optionally pass an array of parcel IDs to drop specific parcels;
// pass undefined to drop everything currently carried.
const dropped = await socket.emitPutdown(selected);
```

Note on coordinates: `up` is `y+1`, `down` is `y-1`, `right` is `x+1`, `left` is `x-1`. This is flipped from screen conventions — keep it consistent in pathfinding.

Moves have duration. The agent's coordinate interpolates during a move (+0.6 toward target, then +0.4 on completion). If another agent is already on the target tile, or the agent trying to move there beats you to it, the move fails and you take a penalty.

Pickup and putdown are instantaneous. A player can hold multiple parcels; a player only gains points when dropping on a delivery (red) tile.

### Messaging

The SDK also provides agent-to-agent messaging primitives (used in multi-agent coordination). Common ones:

```js
await socket.emitSay(toId, message);    // private message to one agent
await socket.emitShout(message);        // broadcast to all agents in range
await socket.emitAsk(toId, message);    // ask-style RPC, resolves with reply
```

Inspect the actual SDK for the exact shapes — these are the commonly-used ones from the course demos.

## Events (listeners)

Register with `socket.on(eventName, handler)`. Handlers for the listed events receive positional args, not a single object.

### Identity

```js
socket.on('you', (id, name, x, y, score) => {
  // fires on connect and whenever the agent's own stats change
});
```

### Map

```js
socket.on('map', (width, height, tiles) => {
  // fires once on connect. `tiles` is the full static map.
});

socket.on('tile', (x, y, delivery) => {
  // per-tile updates if the map changes
});
```

### Sensing (streamed)

```js
socket.on('agentsSensing', (agents) => {
  // Array<Agent> — all agents currently visible within sensing range
});

socket.on('parcelsSensing', (parcels) => {
  // Array<Parcel> — all parcels currently visible within sensing range
});
```

Sensing events fire whenever the visible set changes (agent moves, parcel spawns, reward timer tick, etc.). They carry **only what's currently visible**. Anything previously seen that's now out of range simply won't be in the next event — your belief set has to decide how to handle staleness (decay, keep-last-known, guess, etc.).

### Connection

```js
socket.on('connect', () => { /* authenticated and ready */ });
socket.on('disconnect', () => { /* connection dropped */ });
```

### Messages from other agents

```js
socket.on('msg', (fromId, fromName, message, reply) => {
  // reply is a function — call it to respond to an emitAsk
});
```

## Type shapes

```ts
// Agent
{
  id: string,
  name: string,
  teamId: string,
  x: number, y: number,
  score: number,
  penalty: number
}

// Parcel
{
  id: string,
  x: number, y: number,
  carriedBy?: string,   // agent id if being carried, else undefined
  reward: number        // current reward — decays over time
}

// Tile
{
  x: number, y: number,
  type: '0' | '1' | '2' | '3' | '4' | '5' | '←' | '↑' | '→' | '↓'
  // 0: wall (non-walkable)
  // 1: spawner (green — parcels can spawn here)
  // 2: delivery (red — drop parcels here to score)
  // 3: walkable (white)
  // 4: base
  // 5 / arrows: less common; appear in specialized maps
}
```

The handout's simpler tile legend (`0` none / `1` green / `2` red / `3` white) is the common case. `4` and the arrow types show up in some course maps.

## REST endpoints (admin)

For orchestration or testing setups where you need to spawn parcels, manage agents, or fetch config:

```
GET  /api/agents              list all agents
GET  /api/agents/:id          one agent
GET  /api/parcels             list all parcels
GET  /api/parcels/:id         one parcel
POST /api/tokens              create a token
POST /api/agents              admin agent operations
GET  /api/configs             server config
```

Admin auth is via the admin token. Default admin password on a local server is `admin` (per the handout).

## Minimal working example

```js
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';

const socket = DjsConnect('localhost:8080');

let me = { x: 0, y: 0 };

socket.on('you', (id, name, x, y) => {
  me = { x, y };
});

socket.on('map', async (width, height, tiles) => {
  // walk a canned path, retry blocked moves once
  const path = ['right', 'right', 'down', 'down', 'left', 'left', 'up', 'up'];
  for (const dir of path) {
    let ok = await socket.emitMove(dir);
    if (!ok) {
      await new Promise(r => setTimeout(r, 100));
      ok = await socket.emitMove(dir);
    }
  }
  await socket.emitPickup();
});
```

This is the `hello world` — good for verifying connection, not a useful agent. The agent loop lives in a BDI or LLM structure; see the architecture references.

## Keyboard controls (for debugging via the 3D client)

When the same token is active in both the 3D browser client and your agent script, the browser follows what the agent does. Manual controls in the 3D client:

- `w` / `a` / `s` / `d` — up / left / down / right
- `q` — pickup
- `e` — putdown
- Admin (with admin token): `space` to spawn/dispose parcels, numeric keys to modify tiles
