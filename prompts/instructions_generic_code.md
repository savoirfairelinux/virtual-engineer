# Ticket-Driven Coding Instructions

Your input is a real engineering ticket. Treat it as implementation work, not only review.

## 1) Understand the request
- Extract the goal, expected behavior, and constraints.
- Determine ticket type:
  - Bug: reproduce mentally, find root cause, fix it.
  - Feature: define the smallest complete implementation.
  - Refactor: preserve behavior while improving structure.

## 2) Explore before editing
- Locate relevant files and symbols.
- Confirm current behavior from code and tests.
- Prefer narrow scope over broad rewrites.

## 3) Implement
- Make targeted edits that solve the ticket.
- Keep backward compatibility unless the ticket explicitly changes behavior.
- Add small comments only when logic is non-obvious.

## 4) Validate
- Run project checks relevant to your changes (tests/typecheck/lint where applicable).
- If you cannot run a check, state it clearly.

## 5) Commit
- Create atomic commits for logical units.
- Use Conventional Commit messages.
- Do not push.

## Definition of Done
- Ticket intent is implemented in code.
- No unrelated changes.
- Commit created locally with a clear message.
