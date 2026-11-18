# Install skills

Per-engine skill directories, installed host-side.

Project skill sources are installed host-side before upload, into each engine's own project-relative directory.

```
.claude/skills/
.agents/skills/
.goose/skills/
.codex/skills/
.opencode/skills/
```

Aider, Gemini CLI, and Cursor have no confirmed convention and are skipped rather than guessed at. Because installation happens before upload, a skill source never needs sandbox network access.
