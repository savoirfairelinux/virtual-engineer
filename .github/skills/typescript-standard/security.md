# Security Guidelines for Output Files

This document defines mandatory security rules for all generated output files.

## Core Rule

**Output files must NEVER contain sensitive information that could expose the host system or user credentials.**

## Prohibited Content

The following content types are strictly prohibited in any output files:

### 1. Host Machine Absolute Paths

- Never include absolute filesystem paths from the host machine
- Use relative paths from project root instead
- Examples of prohibited patterns:
  - `/home/username/...`
  - `/Users/username/...`
  - `C:\Users\username\...`

### 2. Credential Information

Never include any of the following:

| Category | Examples |
|----------|----------|
| Environment Variables | `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, API keys, any `*_TOKEN` or `*_SECRET` values |
| SSH Keys | Private keys (`id_rsa`, `id_ed25519`), key passphrases |
| Cryptocurrency Keys | Private keys, seed phrases, wallet secrets |
| Database Credentials | Connection strings with passwords, database passwords |
| Service Credentials | OAuth tokens, JWT secrets, service account keys |

### 3. Private Repository URLs

- Links to GitHub private repositories are treated as credential information
- Only include private repository URLs when **explicitly instructed by the user**
- Public repository URLs are acceptable

## Implementation Guidelines

### When Writing Configuration Files

```typescript
// BAD - Exposes host path
const configPath = '/home/user/projects/myapp/config.json';

// GOOD - Uses relative path
const configPath = './config.json';
// or
const configPath = path.join(__dirname, 'config.json');
```

### When Generating Documentation

```markdown
<!-- BAD -->
Project located at: /home/developer/workspace/project

<!-- GOOD -->
Project located at: ./project (relative to workspace root)
```

### When Writing Test Files

```typescript
// BAD - Hardcoded credential
const token = 'ghp_xxxxxxxxxxxxxxxxxxxx';

// GOOD - Environment variable reference
const token = process.env.GITHUB_TOKEN;
```

### When Creating Example Configurations

```yaml
# BAD
github_token: ghp_actualTokenValue123
ssh_key: |
  -----BEGIN OPENSSH PRIVATE KEY-----
  actual-key-content
  -----END OPENSSH PRIVATE KEY-----

# GOOD
github_token: ${GITHUB_TOKEN}  # Set via environment variable
ssh_key_path: ~/.ssh/id_ed25519  # Reference path, not content
```

## Verification Checklist

Before committing or outputting any file, verify:

- [ ] No absolute host paths present
- [ ] No environment variable values embedded (references are OK)
- [ ] No SSH private keys or key content
- [ ] No cryptocurrency private keys or seed phrases
- [ ] No private repository URLs (unless explicitly requested)
- [ ] No API tokens or secrets hardcoded
- [ ] No database passwords or connection strings with credentials

## Handling User Requests

If a user requests output that would violate these rules:

1. **Warn** the user about the security implications
2. **Suggest** secure alternatives (e.g., environment variables, secret managers)
3. **Only proceed** if the user explicitly confirms after understanding the risks

## References

- OWASP Secrets Management Guide
- GitHub Secret Scanning Documentation
- 12-Factor App: Config
