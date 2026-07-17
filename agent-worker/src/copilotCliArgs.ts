export function buildCopilotCliArgs(port: number): string[] {
  return [
    '--headless',
    '--no-auto-update',
    '--port',
    String(port),
    '--auth-token-env',
    'GITHUB_TOKEN',
    '--no-auto-login',
  ];
}

const COPILOT_NETWORK_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
] as const;

export function buildCopilotNetworkEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of COPILOT_NETWORK_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  return env;
}