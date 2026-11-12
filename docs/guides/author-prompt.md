# Author a prompt

Clone a built-in and bind the clone.

Prompts are database records, not files. Clone a built-in rather than editing it, so a fresh seed stays comparable.

- A `system` prompt sets the role and constraints. An `instructions` prompt sets the procedure for one workflow.
- Both are mandatory on every agent, and resolution is fail-closed.
- The user prompt is generated per cycle and never stored, so never put per-ticket detail in a stored prompt.
- Feedback cycles use `instructions_feedback_code`, which is a separate record from the first-pass instructions.
