# Game Mechanics

What the agent is actually playing against. This is the stuff that has to be in the belief model and the plan evaluation — get any of these wrong and the agent will look smart in unit tests and clumsy in a live run.

## The grid

The world is an `M × N` tile grid. Each tile has a type:

- `0` — **none** (non-walkable, wall)
- `1` — **green / spawner** — parcels can appear here
- `2` — **red / delivery** — drop parcels here to score
- `3` — **white / walkable** — plain walkable tile
- `4` — **base** — less common, map-dependent
- `5` / `←` / `↑` / `→` / `↓` — specialized (directional / conveyor-like tiles on some maps)

The map is fixed for a given game and arrives as a single `map` event on connect. Treat it as immutable unless a `tile` event tells you otherwise.

## Parcels

Each parcel:
- lives at an integer `(x, y)` coordinate
- has a **reward** that decays over game-clock ticks once it spawns
- **disappears** when the reward hits zero, or when it's delivered
- can be **picked up** by any player standing on its tile, **put down** anywhere
- can be **carried** by one player at a time; multiple parcels per player is allowed
- has a `carriedBy` field when held (the agent's id), undefined when on the ground

Multiple parcels can exist simultaneously. New ones spawn on green tiles per the server's spawn config.

**Scoring:** points awarded = parcel's remaining reward at the moment it's dropped on a red (delivery) tile. A parcel picked up with reward 10 and delivered 4 ticks later (if decay is 1/tick) yields 6 points. This is why distance-to-delivery is a first-class concern in parcel evaluation, not an afterthought.

## Actions

The six legal actions: `move_up`, `move_down`, `move_left`, `move_right`, `pick_up`, `put_down`.

### Movement timing

Moves are **not** instantaneous. Each move has a fixed duration (server-configured, map-dependent). During the move:

1. Action starts — agent's coordinate is interpolated by 0.6 toward the target (so an observer sees the agent "between" tiles).
2. Action ends — coordinate completes the remaining 0.4; agent is now on the target tile.

Because of this, you can observe which direction a player is moving in mid-action by reading fractional coordinates. Useful for predicting agent trajectories.

During a move, **both the source and target tiles are locked** — no other agent can step onto either. If you try to move onto a tile another agent is currently on (or moving to), the move **fails** and you take a **penalty**. Penalties reduce score and stay on the agent record.

### Coordinate convention

From `(x, y)`:
- `right` → `(x+1, y)`
- `left`  → `(x-1, y)`
- `up`    → `(x, y+1)`
- `down`  → `(x, y-1)`

`up` increases `y`. This is math-style, not screen-style. Worth stating at the top of any pathfinding file.

### Pickup / putdown

Both instantaneous. Pickup requires being on the same tile as the parcel. Putdown drops on the current tile — points only awarded if that tile is delivery-type.

A single `emitPickup` call grabs all parcels on the current tile. A single `emitPutdown(ids?)` drops either the specified subset or all held parcels.

## Sensing range

Limited visibility — strict inequality:

```
x_offset + y_offset < sensing_distance
```

where `sensing_distance` is typically **5** on the course maps, and `x_offset` / `y_offset` are the absolute distances from the agent's current position. This is an L1 (Manhattan) disk, *exclusive* of the boundary.

So from position `(10, 10)` with `sensing_distance = 5`, the agent can see:
- `(10, 10)` itself (offset 0 + 0 = 0 < 5) ✓
- `(14, 10)` (offset 4 + 0 = 4 < 5) ✓
- `(15, 10)` (offset 5 + 0 = 5 ✗ — NOT visible)
- `(12, 12)` (offset 2 + 2 = 4 < 5) ✓
- `(13, 12)` (offset 3 + 2 = 5 ✗ — NOT visible)

### Implications for beliefs

- **Everything outside the L1 disk is unknown.** Not "assume empty" — genuinely unknown. The belief model has to represent uncertainty, or at least distinguish "known empty" from "unobserved".
- **Previously-seen agents can be guessed.** If you saw an agent at `(5, 8)` three ticks ago, you can assume they're probably still nearby. Good belief models decay this confidence over time rather than treating stale readings as live.
- **Reward timers tick locally.** Once you see a parcel with reward 7, you can compute its decay yourself — you don't need the server to re-send every tick.

### What you're told

On each update the server emits `parcelsSensing` and `agentsSensing` with the current visible set. An item dropping out of the event doesn't mean it's gone — it might have moved out of range.

## Connection & tokens

- A token is required to connect. Get one via the 3D client by entering a name.
- Tokens are **signed by the server** — one signed on localhost won't work on the cloud server, and vice versa.
- Tokens don't expire, but they're per-server-instance.
- Multiple tokens = multiple agents. You can run a whole team from one machine.
- **Same token in two places = same character** — both connections control the same NPC. Useful for "watching" your script play via the 3D client.
- If no client is connected for a token, the NPC is removed after **10 seconds** of inactivity.

## Servers

- **Cloud (free tier):** `https://deliveroojs.azurewebsites.net/` or `https://deliveroojs.onrender.com/`
- **UniTN internal:** `https://deliveroojs.bears.disi.unitn.it/` (primary), `https://deliveroojs.rtibdi.disi.unitn.it/` (fallback). Requires UniTN VPN (GlobalProtect).
- **Local:** `http://localhost:8080` after `npm install && npm run build && npm start` in a clone of https://github.com/unitn-ASA/Deliveroo.js.

For development, local is the fastest feedback loop. The cloud tier is documented as unperformant under load — fine for sanity checks, not for latency-sensitive work.
