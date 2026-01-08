# Test Plan - Needs Task Extraction

This plan has implementation details but no TASK-XX format.
Should skip scout but run planner for task extraction.

## Phase 1: Create the data layer

Create `src/store.ts` with a simple in-memory store:

```typescript
interface Item {
  id: string;
  name: string;
}

export class Store {
  private items: Map<string, Item> = new Map();
  
  add(item: Item): void { ... }
  get(id: string): Item | undefined { ... }
  list(): Item[] { ... }
}
```

## Phase 2: Add persistence

Modify `src/store.ts` to save/load from `data.json`:
- Add `save()` method that writes to disk
- Add `load()` method that reads from disk
- Call `load()` in constructor

**Files:** src/store.ts (modify), data.json (create)
