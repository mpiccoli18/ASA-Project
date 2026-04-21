# External Planning (PDDL) — Phase 1b

Phase 1 asks for two variants: first a BDI agent with a **hand-written plan library**, then the same agent where plans come from an **external planner** called at runtime.

The canonical external-planner approach in the AI/BDI tradition is **PDDL** (Planning Domain Definition Language). PDDL isn't mandatory — any external planning component works — but it's the path of least resistance for the course.

## What external planning buys you

With a plan library, the agent matches an intention (e.g. `pickup(parcel_42)`) to a template plan (e.g. `bfs-path + pickup-action`). That's fine when plan templates cover all intentions, less fine when:

- Multiple parcels need to be picked up in an optimal order (traveling salesman).
- Pickup + delivery routes should be combined (pick up two parcels, deliver both in one trip).
- Obstacles (other agents) force detours the template doesn't know about.

A planner takes the domain (rules), the current state (beliefs), and a goal (intention), and searches for an action sequence. You don't write the sequence — you declare the rules and let search find it.

## PDDL in 5 minutes

PDDL is two files:

**`domain.pddl`** — the rules of the world. Predicates, actions, preconditions, effects. Written once per problem class.

**`problem.pddl`** — this instance. Objects (tiles, parcels), initial state, goal. Regenerated each time you call the planner.

### A minimal Deliveroo domain sketch

```lisp
(define (domain deliveroo)
  (:requirements :strips :typing)
  (:types tile parcel)

  (:predicates
    (at-agent ?t - tile)
    (at-parcel ?p - parcel ?t - tile)
    (carrying ?p - parcel)
    (walkable ?t - tile)
    (delivery ?t - tile)
    (adjacent ?t1 - tile ?t2 - tile))

  (:action move
    :parameters (?from - tile ?to - tile)
    :precondition (and (at-agent ?from) (adjacent ?from ?to) (walkable ?to))
    :effect (and (not (at-agent ?from)) (at-agent ?to)))

  (:action pickup
    :parameters (?p - parcel ?t - tile)
    :precondition (and (at-agent ?t) (at-parcel ?p ?t))
    :effect (and (carrying ?p) (not (at-parcel ?p ?t))))

  (:action putdown
    :parameters (?p - parcel ?t - tile)
    :precondition (and (at-agent ?t) (carrying ?p) (delivery ?t))
    :effect (and (not (carrying ?p)))))
```

And a problem:

```lisp
(define (problem deliveroo-001)
  (:domain deliveroo)
  (:objects
    t_0_0 t_0_1 t_0_2 ... - tile
    parcel_17 - parcel)
  (:init
    (at-agent t_5_5)
    (at-parcel parcel_17 t_7_8)
    (walkable t_0_0) (walkable t_0_1) ...
    (delivery t_9_9)
    (adjacent t_0_0 t_0_1) (adjacent t_0_1 t_0_0) ...)
  (:goal
    (and (not (exists (?p - parcel) (carrying ?p)))
         (forall (?p - parcel) (delivered ?p)))))   ;; or a simpler per-parcel goal
```

The above is a sketch — real PDDL for Deliveroo needs more care around multi-pickup, score tracking, and whether reward decay is modeled. For the course, a reasonable simplification is:

- **Don't model reward decay in PDDL.** Pick targets in JS (BDI layer), pass the chosen target as a goal. Let the planner optimize path only.
- **Don't model other agents in PDDL.** They're dynamic; the planner treats them as static obstacles in a single call. Replan often.
- **Treat each intention as a separate planning call.** `pickup(p)` becomes goal `at-parcel p self`, or `at-agent tile_of_p` then a separate pickup action.

## Calling a planner from Node

Two common choices:

### Option 1 — online planner service

`https://planning.domains/` hosts solver endpoints. POST domain + problem, get back a plan. Easiest setup, no local deps.

```js
async function plan(domainPDDL, problemPDDL) {
  const res = await fetch('https://solver.planning.domains/solve-and-validate', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ domain: domainPDDL, problem: problemPDDL })
  });
  const data = await res.json();
  return data.result?.plan;  // array of action strings
}
```

Cons: network latency per plan call; availability depends on the service.

### Option 2 — local planner binary

Install a planner like Fast Downward, LAMA, or Pyperplan locally, shell out from Node:

```js
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

async function plan(domainPDDL, problemPDDL) {
  await writeFile('/tmp/domain.pddl', domainPDDL);
  await writeFile('/tmp/problem.pddl', problemPDDL);
  return new Promise((resolve, reject) => {
    execFile('fast-downward.py', 
      ['--alias', 'lama-first', '/tmp/domain.pddl', '/tmp/problem.pddl'],
      (err, stdout) => err ? reject(err) : resolve(parsePlan(stdout)));
  });
}
```

Fast, no network dependency, but adds install complexity for graders.

For a course submission, **the online planner is usually better** unless the instructor specifies otherwise — reviewers can run your code without installing a Python planner.

## Integration with the BDI loop

Replace the `selectPlan` step:

```js
async function selectPlan(intention, beliefs) {
  const domain = staticDomain;              // loaded once
  const problem = buildProblem(intention, beliefs);
  const plan = await plan(domain, problem); // external call
  return plan ? parseActions(plan) : null;
}
```

Key points:
- **Build the problem from current beliefs, not the full map.** If the agent only knows 30 of 100 tiles, the problem should only reference those — otherwise it's cheating on the sensing constraint.
- **Timeout the planner call.** A 30-second PDDL call stalls the whole agent. Cap at ~2–5 seconds and fall back to the plan library or a simple BFS.
- **Cache aggressively.** If the problem hasn't changed (same agent position, same parcels, same goal), reuse the last plan.
- **Re-plan on surprise.** Another agent blocks your path → the plan's invalid → call the planner again with the updated state.

## What a reviewer will look for

- Domain + problem files are visible in the repo, not hidden behind hard-coded plans.
- The planner is called through a clean interface (`plan(domain, problem) → actions`) — you could swap planners without rewriting the agent.
- The planner's output is actually executed, with validation (planner-returned actions match what the SDK accepts).
- Sensible handling of planner failure (timeout, unsolvable) — graceful fallback rather than crash.
- A section in the report explaining the domain modeling choices (what you chose not to represent, and why).

## Common pitfalls

- **Oversized problem.** Including every tile on a 50×50 map makes the ground-atom count explode. Prune to only the tiles you need (e.g., BFS-reachable within some radius of agent and target).
- **Asymmetric adjacency.** `(adjacent t1 t2)` without `(adjacent t2 t1)` silently makes moves one-directional. Generate both, or use a symmetric predicate pattern.
- **Goal unreachable.** If the target parcel isn't in a walkable-connected component from the agent, the planner will search forever or return nothing. Pre-check reachability with BFS before calling the planner.
- **Non-PDDL action in plan output.** Parse the planner's output strictly and validate each action exists in your SDK dispatch map.
