# Deliveroo Agent — Project Layout

This is a suggested skeleton. Not prescriptive; reorganize as you see fit.

```
deliveroo-agent/
├── .env                     # HOST, TOKEN, etc. (do not commit)
├── .env.example
├── package.json
├── README.md
├── report/                  # final report (max 10 pages)
│   └── report.md
└── src/
    ├── bdi/                 # Phase 1 — BDI agent
    │   ├── index.js         # entry point
    │   ├── beliefs.js       # belief store + revision
    │   ├── options.js       # desire generation + scoring
    │   ├── intentions.js    # intention selection + revision
    │   ├── plans/           # plan library (Phase 1a)
    │   │   ├── pickup.js
    │   │   ├── deliver.js
    │   │   └── explore.js
    │   └── planner.js       # external planner integration (Phase 1b)
    ├── llm/                 # Phase 2 — LLM-based agent
    │   ├── index.js
    │   ├── memory.js        # context assembly
    │   ├── planner.js       # LLM call + response parsing
    │   ├── tools.js         # tool catalog + dispatch
    │   └── react-loop.js    # ReAct / CoT / Reflexion loop
    ├── coord/               # coordination layer
    │   ├── protocol.js      # message schema
    │   ├── allocator.js     # task allocation logic
    │   └── bridge.js        # BDI <-> LLM connector
    ├── lib/                 # shared utilities
    │   ├── bfs.js
    │   ├── value.js
    │   └── logger.js
    └── run-both.js          # spawns both agents for coordinated runs
```

## Quick start

```bash
npm install
cp .env.example .env
# fill in HOST and TOKEN
node src/bdi/index.js
```

For coordinated two-agent runs, set `TOKEN_SECOND` and run `npm run both`.
