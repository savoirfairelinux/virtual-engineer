---
name: ve-tdd
description: "TDD workflow skill for the virtual-engineer project. Use when writing new features, fixing bugs, or adding test coverage in this codebase. Provides step-by-step red-green-refactor procedure, Vitest patterns, mock conventions, and gate commands specific to this project."
argument-hint: "Describe what you want to implement or test"
---
# Virtual Engineer — TDD Workflow

## Procedure

### 1. Read first

Before writing any code, read:
- The source file you will change (`src/**/*.ts`)
- Its existing test file (`tests/unit/<module>.test.ts`)
- The interfaces it implements (`src/interfaces.ts`)

### 2. Write the failing test

Add a new `it`/`test` block (or a new `describe`) in the relevant test file.
Run `npm test -- --reporter=verbose` and confirm the new test appears as **failed (×)**.

```typescript
// Minimal Vitest test shape
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('MyClass', () => {
  it('does the thing', () => {
    // arrange
    // act
    // assert
    expect(result).toBe(expected);
  });
});
```

### 3. Implement

Write the minimum production code that turns the test green.
- No `any` — use `unknown` and type guards.
- No `console.log` — use `src/logger.ts`.
- Explicit return types on exported functions.

### 4. Run the three gates

All three must exit 0:

```bash
npm test              # all tests pass
npm run typecheck     # zero TypeScript errors (tsconfig.json + tsconfig.agent.json)
npm run lint          # zero ESLint errors
```

### 5. Commit

```
<type>(<scope>): <≤50-char subject, imperative>

<optional body, ≤72 chars per line>
```

Types: `feat`, `fix`, `test`, `refactor`, `perf`, `docs`, `chore`, `ci`  
Scopes: `orchestrator`, `polling-loop`, `state`, `gerrit`, `redmine`, `gitlab`, `agent`, `copilot-cli`, `vcs`, `plugins`, `admin`, `dashboard`, `prompts`, `config`, `workspace`, `db`

## Vitest Mock Patterns

### Mocking a module

```typescript
vi.mock('../path/to/module.js', () => ({
  MyClass: vi.fn().mockImplementation(() => ({
    methodName: vi.fn().mockResolvedValue(result),
  })),
}));
```

### Spying on a method

```typescript
const spy = vi.spyOn(instance, 'methodName').mockResolvedValue(result);
```

### Fake timers (used in pollingLoop tests)

```typescript
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

// Advance timers using runAllTimersAsync only once per test
await vi.runAllTimersAsync();
```

> **Warning**: `vi.runAllTimersAsync()` will abort after 10,000 timer iterations.
> Always call `loop.stop()` before running all timers to prevent infinite-loop detection.

### Reset mocks between tests

```typescript
beforeEach(() => {
  vi.clearAllMocks();
});
```

## Coverage Requirement

Coverage must not drop below the thresholds configured in `vitest.config.ts`.
Use `npm run test:coverage` to check before pushing.

## Project-specific Conventions

| Concern | Location |
|---------|----------|
| Unit tests | `tests/unit/<module>.test.ts` |
| Test helpers / fixtures | `tests/unit/helpers/fixtures.ts` |
| Logger | `src/logger.ts` — import as `log` |
| Config | `src/config.ts` — call `resetConfig()` in `afterEach` when overriding env vars |
| State machine | `src/state/stateMachine.ts` — read before testing transitions |
| SQLite task PK | `task_id` (TEXT), not `id` |
