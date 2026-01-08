# Test Spec - Ready to Execute

This spec has explicit task structure and should skip scout + planner.

## TASK-01: Create greeting module

Create a simple greeting module.

**Files:** `src/greeting.ts` (create)
**Depends on:** none
**Acceptance:** Module exports `greet(name: string): string` that returns "Hello, {name}!"

## TASK-02: Create test file

Create tests for the greeting module.

**Files:** `src/greeting.test.ts` (create)
**Depends on:** TASK-01
**Acceptance:** Test file imports greet and has at least one passing test
