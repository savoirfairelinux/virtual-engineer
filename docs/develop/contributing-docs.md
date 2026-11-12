# Writing docs

Rules this documentation follows.

Documentation lives in the same repository and ships in the same pull request as the code it describes.

## Editing and building

The public documentation is maintained as MyST Markdown in `docs/` in the
[application repository](https://github.com/savoirfairelinux/virtual-engineer/tree/main/docs).
It is published at <https://virtual-engineer.readthedocs.io/>. The marketing
website links here rather than maintaining a second copy.

Edit a page in its topic directory and register new pages in that directory's
`index.md` toctree. Add new sections to `docs/index.rst`. Link to other pages
with relative Markdown paths, for example `[Requirements](../start/requirements.md)`.

Build locally using the
[contributor instructions](https://github.com/savoirfairelinux/virtual-engineer/blob/main/CONTRIBUTING.md#documentation).
The strict Sphinx build must finish without warnings before publishing.

## Rules

- One page, one intention. A title needing "and" is two pages.
- Information exists in exactly one place; everywhere else links to it.
- Exact values — variable names, defaults, state names, paths — come from the code, never from memory.
- Concepts explain why and never contain procedures; guides do the reverse.
- Reference tables are generated from the source of truth where possible, so they cannot drift.
- Warnings are reserved for data loss and security regressions.

## Audience

User-facing pages never describe source layout, and developer pages never explain how to configure a project. If a page needs both, it is two pages.
