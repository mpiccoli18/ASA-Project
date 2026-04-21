# LLM-based Agent Architecture — Phase 2

In Phase 2, the user adds a **second** agent — an LLM-based one — that runs alongside the BDI agent. The BDI agent keeps doing its job. The LLM agent handles:

- **Natural-language objectives** injected from outside (user-given goals like "prioritize parcels in the top-right quadrant" or "avoid the red agent for now").
- **Reasoning over current context** (environment observations + messages from the BDI agent + the objective + available tools) to produce a plan.
- **Iterative replanning** when observations or objectives change, using techniques like ReAct, Reflexion, or Chain-of-Thought.

The course provides an **LLM API endpoint** (accessed via a token) and an **extended tool catalog on a server**. Your agent calls out to both.

## The four components

From the course diagram:

```
       ┌───────────────┐
       │   Memory      │  (LLM context: objective + observations + tool catalog)
       └───────┬───────┘
               │
New obj →  Agent Core  ←→  Planner (LLM)
               │
         ┌─────┴─────┐
         │   Tools    │  (external catalog, called via API)
         └───────────┘
```

- **Memory** — the LLM's context window. Holds the current objective, recent observations from the game environment (and the BDI agent's shared beliefs), and a description of available tools. Updated dynamically.
- **Agent Core** — the controller. Receives new objectives, updates memory, decides when to invoke the planner, executes returned tool calls, and decides when to replan.
- **Planner (LLM)** — the reasoning step. Given memory, produces either a plan (sequence of tool calls) or a next-action decision.
- **Tools** — the action vocabulary. Predefined on a server. The LLM picks which to call; the agent core executes them.

## Memory — what's actually in the context

A practical sectioning for the prompt:

```
[SYSTEM]
You are an autonomous agent playing Deliveroo.js. You have access to tools. 
Return JSON of the form: { "thought": "...", "action": { "tool": "...", "args": {...} } }
Available tools: <tool catalog, auto-injected>

[OBJECTIVE]
<current natural-language objective>

[WORLD]
My position: (x, y), carrying: [...], score: N
Visible parcels: [...]
Visible agents: [...]
Map facts: delivery tiles at [...], sensing range = 5

[SHARED BELIEFS FROM BDI AGENT]
<what the BDI agent has told us — parcels it saw, intentions it has, etc.>

[HISTORY]
Last N actions and their outcomes.

[USER / CURRENT TURN]
What should I do next?
```

Key design questions:
- **How much history?** Last 5–10 actions is usually enough. More bloats tokens without helping.
- **How is the world snapshot updated?** Either re-serialize the full belief set each turn (simpler, costs more tokens), or maintain a running diff (cheaper, trickier). Start with full snapshot.
- **How does BDI-agent communication show up?** As structured items in the shared-beliefs section, e.g. `{from: 'bdi', type: 'parcel-observation', parcel: {...}, at: tick}`.

## The outer loop

```
initialize memory with objective, tool catalog, and initial world state

loop:
    update memory with latest observations (+ any BDI messages, + any new objective)
    response = planner(memory)        # LLM call
    
    if response is a plan (a1, a2, …):
        for action in plan:
            result = execute(action)
            update memory with (action, result)
            if should_replan(result, observations):
                break  # re-enter outer loop
    else if response is a single next action:
        result = execute(response)
        update memory with (response, result)
    
    if objective_achieved or game_over:
        exit
```

### When to replan

Cheap heuristics:
- **Objective changed** — new user input arrived → replan.
- **Tool call failed** — action didn't produce expected result → replan.
- **Surprise observation** — a new high-value parcel appeared, or an agent blocked a planned path → replan.
- **Stale plan** — executed N actions without reassessing → replan.

Don't replan every tick — LLM calls cost tokens and latency. A reasonable default: replan on failure or on surprise, with a maximum plan-length of ~5 actions before forced reconsideration.

## Reasoning techniques

The course calls out three by name:

### Chain-of-Thought (CoT)

Ask the LLM to show its reasoning before the answer. In the prompt: `"First explain your thinking step by step, then output the chosen action."` Helps with multi-step problems; costs tokens.

### ReAct (Reasoning + Acting)

Interleave thought and action in a tight loop. The LLM produces a thought, picks one action, observes the result, produces the next thought, etc. Each turn is small. Pattern:

```
Thought: I should pick up the parcel at (3,4) because it's close and high-value.
Action: move_right
Observation: moved to (3,3)
Thought: One more step down.
Action: move_down
Observation: moved to (3,4), parcel still here.
Thought: Pick it up.
Action: pickup
Observation: picked up parcel_17 with reward 8.
```

Good for environments where each action's outcome meaningfully affects the next. Fits Deliveroo.js well.

### Reflexion

After a plan fails (or after a run/episode), the LLM produces a reflection on *why* it failed and what to do differently, then that reflection is prepended to memory for future planning. Improves over time without retraining.

For a course project, showing one of these implemented is usually enough — don't try to combine all three unless you have time.

## Tools

The course provides a tool catalog on a server — the agent reads it and calls tools via API. Expect tools to include:

- Game actions: `move_up/down/left/right`, `pickup`, `putdown` (mirrors the SDK)
- Querying: `get_parcels`, `get_agents`, `get_position`
- Messaging: `send_to_bdi`, `ask_bdi`
- Possibly utility/info: `distance_to`, `find_path`, `nearest_delivery`

Specifics depend on what the course publishes. The agent's job is:

1. On startup, fetch the catalog and format it into the system prompt (name + description + arg schema per tool).
2. When the LLM returns `{tool: "foo", args: {...}}`, dispatch to the catalog.
3. Return the tool result as an observation in the next turn's memory.

### Tool-call format

Pick one and be consistent:
- **JSON mode**: LLM returns strict JSON `{tool, args}`. Parse, validate against schema, execute. Easiest to make reliable.
- **Function-calling API**: if the course LLM exposes OpenAI-style function calling, use it. Cleaner and less brittle.
- **XML-style tags**: `<action tool="move_up" />`. Works but parse errors are common.

Always validate the tool name is in the catalog and args match the schema. LLMs hallucinate tool names — fail gracefully, feed the error back as an observation, let the next turn correct itself.

## Coordination with the BDI agent

See `multi-agent-coordination.md` for the full pattern. The short version for the LLM side:

- The LLM agent has tools like `send_to_bdi(message)` and treats BDI messages as just another observation type.
- Negotiation can be naive (both agents greedy, occasional messages) or structured (a fixed protocol: "I claim parcel X", "acknowledged", etc.).
- The LLM agent is usually better at *strategy* (handling natural-language objectives, adapting to novel situations); the BDI agent is better at *tight-loop control* (fast response to sensing). Playing to those strengths is often the right division of labor.

## What a reviewer will look for

- Memory is genuinely updated from environment observations, not just from LLM outputs.
- There's a visible reasoning technique (CoT / ReAct / Reflexion) in the prompts and/or logs.
- Replanning is triggered by real conditions (failure, objective change, surprise), not just periodic re-prompts.
- Tools are called through the advertised catalog, not hard-coded.
- The two agents exchange beliefs, not just act independently in the same world.

## Cost / latency pragmatics

- **Cache the tool catalog prompt** — it's static per session, huge token chunk, perfect for prompt caching if the course LLM supports it.
- **Truncate history aggressively** — rolling window of ~10 turns is usually enough.
- **Avoid per-tick LLM calls** — the LLM is too slow for a tight game loop. Use it at a higher level: the BDI agent handles tick-by-tick; the LLM agent does strategy at second-or-slower cadence.
- **Log everything** — prompts, responses, tool calls, outcomes. The report will need examples.
