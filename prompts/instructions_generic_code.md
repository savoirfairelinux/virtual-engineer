# Ticket-Driven Workflow Instructions

Your input is a real engineering ticket. Treat it as implementation work, not only review.
Follow the Agent Instructions for session behavior, tool use, and commit requirements. The rules below only define how to execute the ticket.

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

## Definition of Done
- ALL ticket requirements are implemented — every repository that the ticket touches must have changes.
- No unrelated changes.
- Validation results and any unavailable checks are stated clearly in the final response.
