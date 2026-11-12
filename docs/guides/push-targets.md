# Push targets and reviewers

Commit order and per-provider reviewer rules.

Push targets are ordered by `commitOrder`, so a dependency lands before the repository that consumes it.

## Reviewers

Each target may carry up to 20 reviewer email addresses, and each provider treats them differently.

- **Gerrit** receives one `r=<email>` push option per address.
- **GitLab** resolves the addresses to numeric reviewer ids.
- **GitHub** rejects reviewer emails, because it requires usernames.
