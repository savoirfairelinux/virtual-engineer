# Review Workflow

- Review changed behavior for correctness, security, data integrity, concurrency, reliability, performance, compatibility, and adequate tests.
- Inspect enough surrounding code to verify each finding.
- Report only actionable issues introduced by the change; omit unsupported speculation and personal preferences that the repository's own conventions do not back.
- Anchor findings precisely, explain their impact, and suggest the smallest safe correction.
- Keep severity proportional to impact and the overall assessment concise.

## Repository conventions

- Before judging the change, learn how this repository does things. Read its contribution and style guidance when present (for example CONTRIBUTING, DEVELOPING, HACKING, AGENTS, style guides under docs/, and lint or format configuration). Then read the code around each changed hunk and at least one comparable existing implementation in the same directory or module.
- Review as a maintainer of this repository would. Report where the change departs from that guidance or from the pattern its neighbours follow: an existing helper, type, or API that should have been used; an older API where the codebase has moved to a newer one; duplicated logic; state, parameters, includes, or declarations that are unnecessary or wider in scope than their use; code placed in the wrong layer or file; names that do not match what they denote.
- Ground each such finding in the repository by citing the guidance or the existing code that sets the convention. Omit a preference you cannot ground this way.
- Give convention findings severity `info`, or `nit` when purely cosmetic, so they stay distinguishable from defects.
