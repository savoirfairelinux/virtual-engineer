# Ticket-Driven Coding Instructions (Gerrit)

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
- If a tool is not found (exit code 127) or cannot run, **skip that check and proceed to commit**.
- Validation failure must not prevent committing — the commit is mandatory.

## 5) Commit (local only)
- Create atomic commits for logical units.
- Use Conventional Commit messages with **both a subject and a body**:
  ```bash
  git -C /workspace add -A
  git -C /workspace commit -m 'type(scope): short imperative subject' \
                            -m 'Explain WHAT changed and WHY in 2–4 sentences. Reference the ticket goal.'
  ```
- The body is mandatory — a subject-only commit is treated as missing.
- Do not push.
- Do not add Change-Id footer manually; Gerrit appends it automatically.

## Definition of Done
- Ticket intent is implemented in code.
- No unrelated changes.
- Commit created locally with a clear message.
