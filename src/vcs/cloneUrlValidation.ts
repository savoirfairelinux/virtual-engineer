interface CloneAuthority {
  hostname: string;
  port: string;
}

function invalid(provider: string, detail: string): never {
  throw new Error(`Invalid ${provider} clone URL: ${detail}`);
}

function rejectUnsafeInput(repoUrl: string, provider: string): void {
  if (
    repoUrl.length === 0
    || repoUrl.startsWith("-")
    || repoUrl.startsWith("ext::")
    || /\s/.test(repoUrl)
  ) {
    invalid(provider, "unsupported or unsafe repository value");
  }
}

function parseExpectedAuthority(expectedHost: string, protocol: "https" | "ssh"): CloneAuthority {
  try {
    const parsed = new URL(expectedHost.includes("://") ? expectedHost : `${protocol}://${expectedHost}`);
    return { hostname: parsed.hostname.toLowerCase(), port: parsed.port };
  } catch {
    invalid(protocol === "https" ? "HTTPS" : "SSH", "configured host is invalid");
  }
}

function validateRepositoryPath(pathname: string, provider: string): void {
  const path = pathname.replace(/^\/+/, "");
  if (
    path.length === 0
    || path.split("/").includes("..")
    || path.includes("\\")
  ) {
    invalid(provider, "repository path is invalid");
  }
}

/** Validate an HTTPS clone URL against the provider's configured host. */
export function validateHttpsCloneUrl(repoUrl: string, expectedHost: string, provider: string): void {
  rejectUnsafeInput(repoUrl, provider);
  const expected = parseExpectedAuthority(expectedHost, "https");
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    invalid(provider, "HTTPS repository URL is required");
  }
  if (parsed.protocol !== "https:") invalid(provider, "HTTPS repository URL is required");
  if (parsed.hostname.toLowerCase() !== expected.hostname || parsed.port !== expected.port) {
    invalid(provider, "repository host is not configured");
  }
  if (parsed.search || parsed.hash) invalid(provider, "repository URL cannot contain a query or fragment");
  validateRepositoryPath(parsed.pathname, provider);
}

/** Validate a Gerrit SSH URL or scp-style URL against its SSH configuration. */
export function validateSshCloneUrl(
  repoUrl: string,
  expectedHost: string,
  expectedPort: number,
  expectedUser: string,
  provider: string,
): void {
  rejectUnsafeInput(repoUrl, provider);
  const expected = parseExpectedAuthority(expectedHost, "ssh");
  if (expected.port && expected.port !== String(expectedPort)) {
    invalid(provider, "configured SSH port is invalid");
  }

  if (repoUrl.startsWith("ssh://")) {
    let parsed: URL;
    try {
      parsed = new URL(repoUrl);
    } catch {
      invalid(provider, "SSH repository URL is required");
    }
    if (parsed.protocol !== "ssh:") invalid(provider, "SSH repository URL is required");
    const actualPort = parsed.port || "22";
    if (parsed.hostname.toLowerCase() !== expected.hostname || actualPort !== String(expectedPort)) {
      invalid(provider, "repository SSH host or port is not configured");
    }
    if (parsed.password) invalid(provider, "SSH repository URL cannot contain a password");
    if (parsed.username && decodeURIComponent(parsed.username) !== expectedUser) {
      invalid(provider, "repository SSH user is not configured");
    }
    if (parsed.search || parsed.hash) invalid(provider, "repository URL cannot contain a query or fragment");
    validateRepositoryPath(parsed.pathname, provider);
    return;
  }

  const scpMatch = /^([^@\s/:]+)@([^:\s/]+):([^\s?#]+)$/.exec(repoUrl);
  if (!scpMatch) invalid(provider, "SSH or scp-style repository URL is required");
  const [, user, host, path] = scpMatch;
  if (host?.toLowerCase() !== expected.hostname || user !== expectedUser) {
    invalid(provider, "repository SSH host or user is not configured");
  }
  validateRepositoryPath(path ?? "", provider);
}