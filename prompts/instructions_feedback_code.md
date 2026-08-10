# Feedback Workflow

- Treat the checked-out workspace as your previous patchset; update it in place.
- Read every comment and identify the requested behavior, including change-level comments without a file anchor.
- Reconcile conflicting or inaccurate feedback according to the ticket's intent and the current code.
- Address every actionable concern without unrelated refactors.
- Re-run validation for the affected behavior.
- Amend the existing commit when correcting the same logical change; add a commit only for a distinct change.
