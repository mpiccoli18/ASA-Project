# Multi-Agent Coordination

The Phase 2 deliverable includes **two agents coordinating** — the BDI agent and the LLM-based agent, running as separate processes or separate connections, each controlling its own NPC, sharing beliefs, and dividing work.

This doc covers the coordination layer that sits on top of both agents — not the internals of either.

## The two things they share

### Beliefs

Things one agent knows that the other might not:
- **Parcels the other can't see.** Sensing range is small; agents in different parts of the map see disjoint sets. Sharing `parcelsSensing` outputs multiplies effective vision.
- **Agent positions.** Same reason — more eyes means better guesses about opponents.
- **Map details.** Usually redundant (both agents get the same `map` event), but worth mentioning if one explores a corner the other hasn't been to.
- **Own intentions.** "I'm heading to parcel X" prevents the other agent from also targeting X.

### Coordination decisions

Things they need to agree on:
- **Who takes which parcel.** Avoid both chasing the same one.
- **Who goes to which delivery tile.** If there are multiple, spreading out reduces contention.
- **Right-of-way on narrow paths.** Especially on cramped maps, one agent should yield.
- **Strategic division.** "You handle the north half, I'll handle the south" — works on larger maps.

## Communication channel

The SDK provides agent messaging primitives (see `sdk-api.md`):

- `emitSay(toId, message)` — private message to one agent id
- `emitShout(message)` — broadcast to all in range
- `emitAsk(toId, message)` — RPC-style; resolves with the other agent's reply

Handlers:

```js
socket.on('msg', (fromId, fromName, message, reply) => {
  // reply is a function — call it to respond to an emitAsk
});
```

Message *content* is whatever you make it — the SDK doesn't prescribe a schema. Define one.

## Defining a message protocol

A minimum viable protocol covers three message types:

### 1. Belief updates

```json
{
  "type": "belief",
  "kind": "parcel" | "agent",
  "data": { "id": "...", "x": 3, "y": 5, "reward": 8, "seenAt": 12034 },
  "confidence": 0.9
}
```

Broadcast on observation. The receiving agent folds it into its belief set with the sender's timestamp. Confidence degrades with staleness.

### 2. Intention announcements

```json
{
  "type": "intention",
  "action": "pickup" | "deliver" | "explore",
  "target": { "parcelId": "..." } | { "tile": [x, y] },
  "eta": 5
}
```

"I'm claiming this target." The other agent should remove that target from its own option set unless it has a dramatically better claim (it's much closer, or it's already carrying and heading past).

### 3. Requests / negotiations

```json
{ "type": "request", "kind": "yield", "on": [x, y] }
{ "type": "request", "kind": "claim-swap", "offer": "...", "ask": "..." }
```

For edge cases: blocked paths, trades.

A simple rule of thumb: **the closer agent takes the parcel** unless the other is already committed and closer-to-commit-point. Measure with BFS distance, not Euclidean — walls matter.

## Task allocation strategies

### Greedy local (no coordination)

Each agent picks its best option independently. Works surprisingly well on sparse maps where the agents rarely compete. Bad on dense maps — both converge on the same juicy parcel.

### Broadcast-and-defer

When an agent decides to pursue a parcel, it broadcasts the intention. Other agents defer to existing claims when evaluating their options. If two agents decide simultaneously, the tie-breaker is id lexicographic order (or first-to-send-wins, if the broadcast is reliable and ordered).

Pros: simple, mostly works. Cons: the "claim" is cheap; agents might linger on a claim while a closer opportunity arises.

### Market / auction

Each parcel is auctioned: "parcel X, who wants it?" Each agent bids its expected value (`expected_reward - expected_cost`). Highest bid wins and commits. Re-auction periodically or when a commitment is dropped.

Pros: provably good allocations in stationary environments. Cons: overkill for a 2-agent setup; adds a synchronous step that delays action.

### Zones

Divide the map into regions at game start; each agent is responsible for its region. Simplest; works well on large maps with clear geography.

For a course project with 2 agents, **broadcast-and-defer** is the sweet spot — easy to implement, easy to explain in the report, clearly demonstrates coordination without heavy machinery.

## Practical gotchas

**Message ordering isn't guaranteed.** Don't assume message A arrives before B just because it was sent first. Include timestamps; apply messages in order of their stated time.

**Dual-role beliefs.** If your BDI agent sends a belief update to the LLM agent, don't also have the LLM agent's sensing produce the same update — or dedupe by id + timestamp when folding in.

**Talking to yourself.** In development you might connect both agents with different tokens from the same process. Make sure the channel works across connections, not just by shared memory. If the message protocol only works because both agents read from the same variable, it won't work when deployed as separate processes.

**LLM-agent latency.** If the BDI agent waits for the LLM agent to reply before moving, the BDI loop stalls. Treat LLM replies as async advisory input: BDI acts on its current plan, folds in LLM messages when they arrive.

## Report-friendly patterns

A clean story in the final report:
1. Define the message schema (one page).
2. Show the allocation rule (half a page + pseudocode).
3. Walk through one coordinated scenario (e.g., both agents see the same parcel; announce, defer, one picks up, other goes elsewhere).
4. Show a failure mode and how the protocol recovers (e.g., an agent gets blocked, drops its claim, the other picks up).

Keep it small. A handful of message types covering belief-share + intention-announce + yield-request is plenty.

## What a reviewer will look for

- Two distinct agents running (BDI + LLM), each with its own loop.
- A messaging protocol with structured messages (not just string text).
- Concrete coordination behaviors — no "both greedily pick X and collide".
- Belief exchange demonstrably extending what each agent knows.
- Replanning triggered by incoming messages, not just by environment sensing.
