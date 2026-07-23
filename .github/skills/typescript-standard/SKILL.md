---
name: typescript-standard
description: "Use when writing, reviewing, or refactoring TypeScript code. Provides type safety patterns, error handling, async programming guidelines, and commit message standards."
---

# TypeScript Coding Standards

This skill provides modern TypeScript coding guidelines and best practices for this project.

## When to Apply

Apply these standards when:
- Writing new TypeScript code
- Reviewing or refactoring existing TypeScript code
- Designing module APIs and interfaces
- Implementing error handling strategies

## Core Principles

1. **Type Safety Over Convenience** - Never sacrifice type safety for shorter code
2. **Explicit Over Implicit** - Make types and intentions clear
3. **Simple Over Clever** - Prefer readable code over clever abstractions
4. **Fail Fast** - Catch errors at compile time, not runtime

## Quick Reference

### Must-Use Patterns

| Pattern | Use Case |
|---------|----------|
| Discriminated Unions | State machines, API responses, Result types |
| Branded Types | IDs, emails, validated strings |
| `readonly` | Data that should not mutate |
| `unknown` in catch | Safe error handling |
| Explicit undefined checks | Array/object indexed access |

### Must-Avoid Anti-Patterns

| Anti-Pattern | Alternative |
|--------------|-------------|
| `any` type | `unknown` with type guards |
| Throwing exceptions for control flow | Result type pattern |
| Optional chaining without null check | Explicit narrowing |
| Deep folder nesting (>3 levels) | Flat, feature-based structure |
| Implicit `undefined` in optional props | Explicit `T \| undefined` |

## Detailed Guidelines

For comprehensive guidance, see:
- [Error Handling Patterns](./error-handling.md) - Result types, discriminated unions, neverthrow
- [Type Safety Best Practices](./type-safety.md) - Branded types, strict config, type guards
- [Async Programming Patterns](./async-patterns.md) - Promise handling, concurrent execution
- [Security Guidelines](./security.md) - Credential protection, path sanitization, sensitive data handling

## tsconfig.json Strict Mode

This project uses maximum TypeScript strictness. Ensure your code compiles with:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "allowUnreachableCode": false
  }
}
```

## TDD Workflow

All code changes follow test-driven development — use the **ve-tdd** skill for the full red-green-refactor procedure, Vitest patterns, and mock conventions. The three gates before every commit:

```
npm test            # all tests must pass
npm run typecheck   # zero TypeScript errors
npm run lint        # zero ESLint errors
```

## Commit Message Standard

This project uses **Conventional Commits** with the following constraints enforced by Gerrit:

- Subject line: `<type>(<scope>): <description>` — **≤50 characters**, imperative mood, no trailing period.
- Blank line between subject and body.
- Body lines: **≤72 characters**.
- Footer: `Closes #<n>` or `BREAKING CHANGE: <desc>` when applicable.

### Types

| Type | When to use |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `test` | Tests only |
| `refactor` | No feature / no bug fix |
| `perf` | Performance |
| `docs` | Documentation |
| `chore` | Build, deps, config |
| `ci` | CI/CD pipeline |

### Scopes (this project)

`orchestrator`, `polling-loop`, `state`, `gerrit`, `redmine`, `gitlab`, `agent`, `copilot-cli`, `vcs`, `plugins`, `admin`, `dashboard`, `prompts`, `config`, `workspace`, `db`

### Examples

```
feat(orchestrator): add CLOSING state transition

Adds CLOSING as intermediate step between MERGED and DONE so
Redmine is closed before the task reaches terminal state.
```

```
fix(state): prevent duplicate active tasks per ticket
```

```
test(gerrit): cover resolveComments grouping by file
```