# Smart Routing Tests

Tests for the smart input routing feature.

## Quick Start

```bash
# Run all fast tests (no LLM)
npx jiti tests/routing-unit.test.ts
npx jiti tests/routing-integration.test.ts

# Full E2E test with actual coordination (uses LLM, ~$0.10-0.50)
pi "coordinate({ plan: 'tests/fixtures/spec.md', mode: 'spec', costLimit: 0.50 })"
```

## Test Types

### Unit Tests (~35 tests, <1s)

```bash
npx jiti tests/routing-unit.test.ts
```

Tests pure functions:
- Detection heuristics (spec/plan/request signals)
- Signal isolation (spec signals don't leak to plan)
- PRD augmentation formatting
- Clarification extraction

### Integration Tests (~13 tests, <1s)

```bash
npx jiti tests/routing-integration.test.ts
```

Tests observability infrastructure:
- Fixture file detection
- `routing-info.json` reader
- `events.jsonl` parser (including malformed line handling)
- Phase event categorization
- Cost tracking from events
- Routing logic validation

### E2E Tests (manual, uses LLM)

```bash
# Test spec mode (skips scout + planner)
pi "coordinate({ plan: 'tests/fixtures/spec.md', mode: 'spec', costLimit: 0.50 })"

# Test plan mode (skips scout, runs planner)  
pi "coordinate({ plan: 'tests/fixtures/plan.md', mode: 'plan', costLimit: 0.50 })"

# Test request mode with auto-detection
pi "coordinate({ plan: 'tests/fixtures/request.md', costLimit: 0.50 })"
```

Then inspect `routing-info.json` and `events.jsonl` in the coordination directory.

## Test Output

Tests create directories in `tests/output/` for debugging. Old directories (>7 days) are automatically cleaned up on each run.

```
tests/output/
├── routing-reader-2026-01-08T10-30-00/
│   └── routing-info.json
├── events-reader-2026-01-08T10-30-01/
│   └── events.jsonl
└── ...
```

## Fixtures

| File | Detected As | Key Signals |
|------|-------------|-------------|
| `spec.md` | spec | TASK-XX, files, acceptance |
| `plan.md` | plan | code blocks, file paths |
| `request.md` | request | prose only |

## Adding Tests

### Unit Test

```typescript
// In routing-unit.test.ts
await runner.test("my detection test", () => {
  const result = detectInputType("TASK-01: Test\nfiles: [a.ts]");
  assertEqual(result.type, "spec");
});
```

### Integration Test

```typescript
// In routing-integration.test.ts
await runner.test("my reader test", () => {
  const coordDir = createTestCoordDir("my-test");
  createMockRoutingInfo(coordDir, { mode: "spec", skipScout: true });
  
  const routing = readRoutingInfo(coordDir);
  assertEqual(routing.mode, "spec");
  
  return { coordDir }; // Keep for debugging
});
```

## Test Utilities

Key helpers in `test-utils.ts`:

| Function | Description |
|----------|-------------|
| `readRoutingInfo(dir)` | Parse `routing-info.json` |
| `readEvents(dir)` | Parse `events.jsonl` |
| `getPhaseEvents(dir)` | Categorize phase events |
| `getCostFromEvents(dir)` | Extract final cost |
| `createMockRoutingInfo(dir, info)` | Create test fixture |
| `createMockEvents(dir, events)` | Create test fixture |
| `cleanupOldTestDirs()` | Remove dirs >7 days old |
