# Push targets and reviewers

Commit order and per-provider reviewer rules.

Push targets are ordered by `commitOrder`, so a dependency lands before the repository that consumes it.

## Clone URLs

GitHub and GitLab push targets must use HTTPS on the linked integration's
trusted Git origin (scheme, host, and effective port), without credentials
embedded in the saved URL. For GitHub.com, use `https://github.com`, not its
API host. GitHub Enterprise and self-hosted GitLab use the integration's
configured base URL, including any non-default HTTPS port. GitLab.com uses
`https://gitlab.com` when no custom base URL is configured.

A separate mirror origin is not automatically trusted. If a mirror is an
approved GitHub Enterprise or GitLab endpoint, configure a dedicated integration
with that HTTPS base URL and credentials intended for that endpoint.

The check runs when saving push targets and again before each coding workspace
clone. If a previously saved target no longer matches, the cycle stops before
cloning any target. Correct the saved URL or its integration before retrying.
Gerrit SSH targets are unaffected.

## Reviewers

Each target may carry up to 20 reviewer email addresses, and each provider treats them differently.

- **Gerrit** receives one `r=<email>` push option per address.
- **GitLab** resolves the addresses to numeric reviewer ids.
- **GitHub** rejects reviewer emails, because it requires usernames.
