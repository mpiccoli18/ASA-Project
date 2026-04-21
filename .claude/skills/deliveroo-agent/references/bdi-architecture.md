# BDI Agent Architecture — Phase 1

The BDI (Beliefs–Desires–Intentions) architecture splits the agent into three layers that loop continuously:

- **Beliefs**: what the agent thinks is true about the world (derived from sensing + memory).
- **Desires / Options**: possible goals it could pursue given its beliefs.
- **Intentions**: the subset of desires it has committed to, each with a plan being executed.

The course rubric expects to see:
- Belief representation with a **belief revision** step (sensing → updated beliefs).
- Intention activation from desires + **intention revision** (dropping or reprioritizing in light of new beliefs).
- Plan selection from a **plan library** (Phase 1a) OR plan generation from an **external planner** (Phase 1b).
- Action execution against the environment, with replanning/redeliberating when things change.

Don't let the acronym drive over-design. A working BDI loop in Deliveroo.js fits comfortably in a few hundred lines of JS.

## Minimal loop

```
on sensing event:
    beliefs = reviseBeliefs(beliefs, sensing)
    desires = generateOptions(beliefs)
    intentions = filterIntentions(intentions, desires, beliefs)

    if currentIntention is still valid:
        continue executing
    else:
        currentIntention = pickBest(intentions)
        plan = selectPlan(currentIntention, beliefs)  // from library or planner
        execute(plan)
```

This is the skeleton. Every component below plugs into it.

## Beliefs

Minimum useful belief set for this game:

| Belief            | Derived from                                   | Notes                                           |
| ----------------- | ---------------------------------------------- | ----------------------------------------------- |
| `me`              | `you` event                                    | id, name, position, score, currently carried    |
| `map`             | `map` event + optional `tile` events           | static; tile types; precomputed walkability     |
| `parcels`         | `parcelsSensing` + local decay                 | keyed by id; decays reward each tick            |
| `agents`          | `agentsSensing` + staleness tracking           | keyed by id; last-seen position + timestamp     |
| `carrying`        | derived from `parcels[id].carriedBy === me.id` | list of held parcels                            |
| `deliveryTiles`   | filtered from map                              | precompute once — avoid scanning every tick     |
| `spawnerTiles`    | filtered from map                              | same                                            |

### Belief revision

Two flavors of update:

1. **Authoritative overwrite** — for things the server tells you directly: `me`, currently-visible parcels, currently-visible agents. When a `parcelsSensing` event fires, the parcels it contains are ground truth for their current values.

2. **Decay / guess** — for things that have dropped out of sensing range. Two common strategies:
   - **Forget**: remove them from beliefs immediately. Safe but wasteful — you ignore that you just saw a juicy parcel at a known location.
   - **Stale-track**: keep them with a "last seen" timestamp. Use in plan evaluation (with degraded confidence), re-verify when you get close.

Reward decay can be computed locally: if you saw a parcel with reward `R` at game-tick `T₀`, at tick `T` the reward is approximately `max(0, R - (T - T₀) * decay_rate)`. The decay rate is map-configured — observe a parcel over a few ticks to measure it if not documented.

## Desires / options

From beliefs, enumerate what the agent *could* do:

- `pickup(parcelId)` — for each visible, uncarried parcel
- `deliver()` — if carrying at least one parcel
- `explore(region)` — to reduce uncertainty in unobserved areas
- `idle()` — fallback

Scoring options is the interesting part. A reasonable value function for picking up parcel `p`:

```
value(p) = expected_reward_at_delivery(p) - time_cost(travel_to_p + travel_to_nearest_delivery)
```

where `expected_reward_at_delivery(p) = max(0, p.reward - decay_rate * (distance_to_p + distance_from_p_to_delivery))`.

For deliver, the value is the sum of currently-held parcels' rewards minus the decay cost of the delivery trip.

## Intentions

An intention is a committed desire with a plan. A simple representation:

```js
{
  id: 'pickup-parcel-42',
  type: 'pickup',
  target: { parcelId: 42 },
  plan: ['move_right', 'move_right', 'move_up', 'pickup'],
  planCursor: 2,   // next step to execute
  score: 17.4      // value at time of adoption
}
```

### Intention revision

On each sensing update, for the current intention, ask:

1. **Is it still achievable?** (parcel still exists, not carried by someone else, path still walkable)
2. **Is it still valuable?** (reward hasn't decayed below threshold)
3. **Is there something dramatically better?** (a higher-value option worth dropping this for)

Dropping an intention has a cost — you wasted steps getting partway to it. Factor that in: only switch if the new option's value exceeds the current one by at least the sunk-cost of abandoning it.

A common gotcha: don't re-deliberate every tick at full depth. Cheap checks (is my target still there?) every tick; expensive re-scoring at a coarser cadence (every N ticks or on specific triggers like "picked up a parcel" / "reached a tile").

## Plans

### Plan library (Phase 1a)

Hand-written plans for the small set of intention types. Each plan is a function:

```js
function planPickup({ parcelId, beliefs }) {
  const parcel = beliefs.parcels.get(parcelId);
  if (!parcel) return null;                       // can't make a plan
  const path = bfs(beliefs.map, beliefs.me, parcel);
  if (!path) return null;
  return [...pathToMoves(path), 'pickup'];
}
```

The handout's simplification: "parcels are known since the beginning" means for the library version you can treat all parcels as visible from the start. That's a test-mode convenience, not how the real game works.

### External planner (Phase 1b)

Instead of hand-written plans, the agent builds a planning problem and delegates. See `pddl-planning.md` for the PDDL approach. The loop is the same — `selectPlan` just calls out to a planner that returns action sequences.

## Plan execution

Execute moves one at a time, awaiting each. Handle failure explicitly — a failed move means you're blocked, and the plan has to adapt:

```js
async function execute(plan, socket) {
  for (const action of plan) {
    const ok = await dispatch(action, socket);
    if (!ok) return { status: 'failed', at: action };
  }
  return { status: 'complete' };
}
```

A common pattern: on `status: 'failed'`, don't re-plan immediately — other agents move. Wait one tick (observe a `parcelsSensing` or `agentsSensing` update), then replan. This avoids ping-ponging against another agent that's crossing your path.

See `assets/snippets/resilient-move.js` for a retry wrapper.

## What a reviewer will look for

- Sensing data goes through a belief-revision function, not straight into the planner.
- The agent explicitly generates options, not just "execute the first thing sensed".
- Intentions get revisited — a better-scoring option can preempt the current plan.
- Plan failures trigger replan, not crash-or-retry-forever.
- Phase 1b: the planner is called as a separate component with a clean interface.

## Common failure modes

- **Oscillation**: two agents blocking each other, each replanning to go through the other. Mitigate with a random-tiebreak wait, or a shared coordination protocol (see `multi-agent-coordination.md`).
- **Parcel-chasing**: committing to a far-away high-reward parcel that decays to zero before you arrive. Mitigate with the distance-aware value function above.
- **Greedy multi-pickup**: picking up everything in sight, then the decay on the held parcels outweighs new pickups. Mitigate by capping "carrying" value and preferring delivery when held-decay cost exceeds next-pickup gain.
- **Stale beliefs**: acting on an agent position observed 30 ticks ago as if live. Always include recency in belief use.
