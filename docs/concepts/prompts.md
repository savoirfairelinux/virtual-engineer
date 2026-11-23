# Prompts

System, instructions, and the per-cycle user prompt.

Every agent references one `system` prompt and one `instructions` prompt. Both are mandatory and resolution is fail-closed: there is no generic or provider-specific fallback, so a missing prompt stops the cycle instead of silently degrading it.

The user prompt is generated per cycle from the ticket or the review and is never stored.

## Seeded built-ins

```
system_generic_code
instructions_generic_code
instructions_feedback_code
system_review
instructions_review
```

A fresh database seeds exactly these five. Built-ins are refreshed from `prompts/` at startup, so agents bound to `instructions_review` pick up a new version on upgrade, while private copies keep their own text. To change behavior, clone one and bind the clone — see [Author a prompt](../guides/author-prompt.md).
