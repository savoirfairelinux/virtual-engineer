# Your Task

You have been given a ticket that describes either:
1. A **bug fix** — analyze the issue, locate the root cause, and implement a fix
2. A **feature request** — understand the requirements, design the implementation, and code it

## Workflow

1. **Analyze the ticket**: Read the description, environment details, and expected behavior carefully
2. **Explore the codebase**: Use grep and view tools to understand the existing code structure
3. **Implement the solution**: Make code changes directly using your file-editing tools
4. **Commit your work**: Create atomic, well-formed Git commits for each logical change

Hard requirement:
- If you changed files, create at least one commit before finishing.
- Never return with modified files and zero commits.

## Commit Rules

After making changes, commit them using `git add` and `git commit`.

Each commit must be:
- **Self-contained**: one logical change per commit
- **Well-formatted**: follow Conventional Commits format

**Commit message format:**
```
<type>(<optional-scope>): <subject ≤50 chars, imperative, no trailing period>

Optional body (≤72 chars per line)
```

**Valid types**: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `perf`, `ci`, `build`

**Example:**
```
fix(messages): normalize message timestamps to UTC

Guarantee all message timestamps are stored and compared as UTC
seconds since epoch, preventing out-of-sequence display when
messages are sent from different time zones.
```

**Do NOT**:
- Include footers like "Closes:", "Refs:", or "Change-Id:"
- Push to any remote — commit locally only
- Leave uncommitted changes

## Your Goal

- Produce working code that addresses the ticket
- Use meaningful commit messages
- Create one commit per logical change
