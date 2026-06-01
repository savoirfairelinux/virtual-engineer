# Ticket-Driven Coding Instructions

Your input is a real engineering ticket. Treat it as implementation work, not only review.

## 1) Understand the request
- Extract the goal, expected behavior, and constraints.
- Determine ticket type:
  - Bug: reproduce mentally, find root cause, fix it.
  - Feature: define the smallest complete implementation.
  - Refactor: preserve behavior while improving structure.

## 2) Quick exploration (≤10 tool calls)
- Find the 2-3 most relevant files. Do NOT exhaustively scan the codebase.
- If the codebase is large, target your search by name/pattern.
- Move on to editing as soon as you have enough context.

## 3) Implement
- Make targeted edits that solve the ticket.
- Keep backward compatibility unless the ticket explicitly changes behavior.
- Add small comments only when logic is non-obvious.

## 4) Validate
- Run project checks relevant to your changes (tests/typecheck/lint where applicable).
- If you cannot run a check, state it clearly.

## 5) Commit
- Create atomic commits for logical units.
- Use Conventional Commit messages with **both a subject and a body**:
  ```bash
  git -C /workspace add -A
  git -C /workspace commit -m 'type(scope): short imperative subject' \
                            -m 'Explain WHAT changed and WHY in 2–4 sentences. Reference the ticket goal.'
  ```
- The body is mandatory — a subject-only commit is treated as missing.
- Do not push.

## Definition of Done
- ALL ticket requirements are implemented — every repository that the ticket touches must have changes.
- No deferred work. Do NOT write "let me know", "Next:", or anything implying future steps.
- No unrelated changes.
- A commit created locally in every repository you modified.
