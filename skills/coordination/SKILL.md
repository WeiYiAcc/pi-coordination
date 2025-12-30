# Coordination Skill

Multi-agent coordination for parallel plan execution.

**YOU HAVE THE `coordinate` TOOL AVAILABLE.** When asked to execute a plan with multiple workers, run tasks in parallel, or coordinate multi-step work - USE THE `coordinate` TOOL, not `subagent`.

## When to Use `coordinate`

Use the `coordinate` tool when:
- User asks to "run a plan with X workers"
- User wants "parallel execution" of steps
- A plan has multiple independent tracks
- Work spans multiple files that different agents could handle
- Complex work would benefit from divide-and-conquer approach
- User mentions "coordination", "parallel workers", or "split the work"

**Do NOT use `subagent` for parallel plan execution** - use `coordinate` instead.

## Tool Parameters

```typescript
coordinate({
  plan: string,   // Path to markdown plan file
  agents: string[] // Array of agent types, e.g. ["worker", "worker", "worker"]
})
```

## Example Invocations

User: "Execute plan.md with 4 workers"
-> coordinate({ plan: "./plan.md", agents: ["worker", "worker", "worker", "worker"] })

User: "Run this plan in parallel"
-> coordinate({ plan: "./plan.md", agents: ["worker", "worker"] })

User: "Split the authentication work across 3 agents"
-> coordinate({ plan: "./auth-plan.md", agents: ["worker", "worker", "worker"] })

## How It Works

1. **Coordinator spawns** and analyzes the plan for dependencies
2. **Workers spawned** with detailed handshake specs defining what each owns/depends on
3. **Contracts defined** for shared interfaces (types, functions, files)
4. **Parallel execution** - workers run simultaneously, coordinating via contracts
5. **Progress visible** in TUI with animated spinners and status updates
6. **Final summary** shows completion status and any deviations

## TUI Display

The coordinate tool provides real-time visibility:

**During startup:**
```
ok 0/4 agents | 0 msgs
⠹ worker  ⠹ worker  ⠹ worker  ⠹ worker
Coordinator starting up (waiting for LLM response)...
```

**While running:**
```
ok 2/4 agents | 35 msgs
ok worker:04ea  ok worker:52e2  .. worker:952d  .. worker:7407
+0.0s [coordinator] Spawned 4 workers
+1.2s [worker-04ea] [tool] write
+1.3s [worker-52e2] Creating store with CRUD operations
```

**When complete:**
```
ok 4/4 completed
ok worker:04ea  ok worker:52e2  ok worker:952d  ok worker:7407
---
## Coordination Complete
All 4 workers executed successfully...
```

## Dependency Detection

The coordinator automatically detects:
- **File dependencies**: Step creates file X, later step imports from X
- **Type dependencies**: Types/interfaces needed before implementations
- **Explicit markers**: "After step X..." or "Uses X from step Y..."

Example linear dependency:
```
Step 1: types.ts (foundational)
    ↓
Step 2: store.ts (imports Todo type)
    ↓
Step 3: handlers.ts (imports store)
    ↓
Step 4: routes.ts (imports handlers)
```

## Contracts Between Workers

Workers coordinate via contracts:
- **signal_contract_complete**: Worker signals it has created a dependency
- **check_messages**: Worker checks for updates from other workers
- **send_message**: Worker communicates status to coordinator

Workers don't need to wait for files to exist - they know the expected interfaces from their handshake specs.

## Available Agent Types

Common agents for coordination:
- `worker` - General-purpose implementation agent
- `code-reviewer` - Reviews code for issues (use sparingly)
- `scout` - Fast codebase reconnaissance

Example with mixed team:
```typescript
coordinate({ 
  plan: "./plan.md", 
  agents: ["worker", "worker", "worker", "code-reviewer"] 
})
```

## Plan Format

Plans should be markdown with clear steps:

```markdown
# My Plan

## Step 1: Create Types
Create `src/types.ts` with the Todo interface.

## Step 2: Create Store
Create `src/store.ts` with CRUD operations. Imports Todo from types.

## Step 3: Create Handlers
Create `src/handlers.ts` with HTTP handlers. Imports from store.
```

## Limitations

- Workers are separate pi processes (file-based communication)
- Initial coordinator startup takes ~10-15s (LLM latency)
- Plans should have clear step boundaries
- Works best with 2-6 workers
