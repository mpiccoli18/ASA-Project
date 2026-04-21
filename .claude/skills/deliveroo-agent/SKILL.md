---
name: deliveroo-agent
description: Reference and scaffolding for building autonomous agents for the UniTN Deliveroo.js course project (Autonomous Software Agents, A.A. 2025-2026). Use whenever the user is working on a Deliveroo.js agent, the BDI agent, the LLM-based agent, the @unitn-asa/deliveroo-js-sdk, parcel pickup/delivery logic, grid sensing, game tokens, or anything referencing DjsConnect, DjsClientSocket, emitMove/emitPickup/emitPutdown, or agent coordination between a BDI and an LLM agent. Also use when the user mentions PDDL planning in a game context, belief revision, intention selection, or LLM-based replanning against a grid environment.
---

# Deliveroo Autonomous Agent

Reference material and patterns for the UniTN Autonomous Software Agents course project. The project requires building an NPC that plays Deliveroo.js — a grid-based parcel delivery game — autonomously, first as a BDI agent (Phase 1), then extended with an LLM-based agent that coordinates with the BDI agent (Phase 2).

The skill is deliberately light-touch: it gives Claude the API surface, game mechanics, and architectural patterns, then gets out of the way so the user can make their own design choices. Don't push a specific BDI implementation or file layout unless the user asks for one.

## When the user is just starting

If the repo is empty or the user is scaffolding, check `assets/project-scaffold/` for starter files (`package.json`, `.env.example`, `config.js`, a minimal connect-and-observe agent). Copy what's needed; don't dump everything.

Before writing any connection code, confirm with the user:
- Which server they're using: local (`localhost:8080`), cloud (`deliveroojs.onrender.com` / `deliveroojs.azurewebsites.net`), or UniTN internal (`deliveroojs.bears.disi.unitn.it`, needs VPN)
- Whether they already have a token (generated via the 3D client by entering a name)

Put the host and token in a `.env` file — never hard-coded in source. The SDK reads `HOST` and `TOKEN` (or `NAME` to auto-generate) from env.

## Routing — which reference to load

Load at most one or two references at a time. Don't preload everything.

| If the user is working on…                                             | Load                                  |
| ---------------------------------------------------------------------- | ------------------------------------- |
| Connecting, sensing events, or calling `emitMove`/`emitPickup`/etc.    | `references/sdk-api.md`               |
| Game rules, sensing range, action timing, tile types, scoring          | `references/game-mechanics.md`        |
| Phase 1: beliefs, desires, intentions, revision, plan library          | `references/bdi-architecture.md`      |
| Phase 2: LLM memory, planner/replanner, tool catalog, ReAct/CoT        | `references/llm-agent-architecture.md`|
| Two agents talking to each other, allocating parcels, sharing beliefs  | `references/multi-agent-coordination.md` |
| PDDL / external planner integration (mentioned as an option in Part 1) | `references/pddl-planning.md`         |

If the user asks a cross-cutting question, read the relevant references in sequence, not all at once.

## Working-code snippets

`assets/snippets/` contains small, copy-pasteable patterns that come up repeatedly:

- `resilient-move.js` — retry wrapper around `emitMove` with configurable backoff
- `bfs-pathfind.js` — shortest path on the tile grid, ignoring non-walkable tiles
- `parcel-value.js` — expected-value scoring for parcels given distance + decay
- `belief-set.js` — minimal mutable belief store with change notifications
- `intention-queue.js` — priority queue for intentions with revision hooks

Read a snippet with `view` before suggesting it — don't quote from memory. Adapt to the user's code style; don't paste verbatim if their project already has conventions.

## Things to get right

A few details the course materials emphasize that are easy to miss:

**Sensing is limited.** `x_offset + y_offset < 5` (Manhattan-ish, strictly less than 5). Anything outside that radius is unknown. Previously-seen agents have to be *guessed*, not treated as ground truth. Parcel reward timers tick locally once observed.

**Moves take time.** Between start and end of a move, the agent's coordinate updates by 0.6 first, then 0.4 on completion. The start and end tiles are both locked during the move. Another agent can block you — moves fail and you accrue a penalty. Pickup and putdown are instantaneous.

**Coordinates are flipped from screen convention.** `up` increases `y`, `down` decreases `y`. Right/left behave normally. Worth stating explicitly in pathfinding code because off-by-one flips are painful to debug.

**Parcel reward = remaining timer at delivery.** So the value of picking up a parcel is not its current reward — it's the reward you'll have left when you can actually drop it in a red tile. Distance matters.

**You can carry multiple parcels.** `emitPutdown(selected)` takes an array of parcel IDs, or `undefined` to drop all. Multi-carry + delivery-route optimization is one of the easier wins.

**Tokens don't expire but are per-server.** A token signed by the local server won't work on the cloud server and vice versa. If connection fails with auth errors, check the server matches the token source.

**If no client is connected for a given token, the NPC is removed after 10 seconds.** This matters for multi-agent setups and for debugging disconnects.

## Phase 1 vs Phase 2 — what the deliverable actually is

**Phase 1 (BDI):** An agent that senses, maintains beliefs, deliberates intentions, and executes from a predefined plan library. Then the same agent extended to call an external planner (e.g., PDDL) to generate plans on the fly instead of using the library. Parcels can be assumed known at start for the library version.

**Phase 2 (LLM):** A *second* agent, LLM-based, that coexists with the BDI agent. It reads natural-language objectives, updates LLM memory from environment observations and messages from the BDI agent, picks tools from a predefined catalog on the course server, and replans when the environment or objective changes. The two agents exchange beliefs (e.g., "I can see a parcel you can't") and coordinate (e.g., "you're closer, you take it").

Deliverable: JavaScript code + a report (max 10 pages) + oral presentation. Code and report are both evaluated.

## Style expectations

The user is an Apple-platform developer working outside their home turf here. Prefer:
- Clear, readable JS with ES modules (`import`/`export`) since the SDK ships as ESM
- Async/await over raw promise chains
- Small pure functions over classes for belief revision and planning logic (easier to test)
- Explicit types via JSDoc comments where it clarifies intent — this is a course project, not a TypeScript conversion

Don't over-engineer. The grader cares that the BDI loop works, beliefs get revised, intentions get reconsidered, and the LLM agent demonstrably replans. Flashy abstractions that obscure the loop hurt more than they help.
