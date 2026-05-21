import Database from 'better-sqlite3';
import { decryptToken } from '../src/utils/encryption.js';
import { exchangeForSessionToken } from '../src/agents/copilotModelsService.js';

async function main() {
  const database = new Database('./data/virtual-engineer.db');
  const rows = database.prepare('SELECT config_json FROM integrations WHERE type = ?').all('copilot') as { config_json: string }[];
  const config = JSON.parse(rows[0]!.config_json) as Record<string, string>;
  const oauthToken = decryptToken(config['sessionToken']!, undefined);
  const sessionToken = await exchangeForSessionToken(oauthToken);

  const res = await fetch('https://api.githubcopilot.com/models', {
    headers: {
      'Authorization': `Bearer ${sessionToken}`,
      'Copilot-Integration-Id': 'vscode-chat',
      'Accept': 'application/json',
    }
  });
  const data = await res.json() as { data?: Record<string, unknown>[] };
  const models = data.data ?? [];

  // Find all top-level keys
  const allKeys = new Set<string>();
  models.forEach(m => Object.keys(m).forEach(k => allKeys.add(k)));
  console.log('Top-level keys:', [...allKeys].sort().join(', '));

  // Check for billing/multiplier on any model
  models.forEach(m => {
    if (m['billing']) console.log(m['id'], 'billing:', JSON.stringify(m['billing']));
    if (m['request_multiplier'] !== undefined) console.log(m['id'], 'request_multiplier:', m['request_multiplier']);
  });

  // Show context window for each model
  models.forEach(m => {
    const caps = m['capabilities'] as Record<string, unknown> | undefined;
    const limits = caps?.['limits'] as Record<string, unknown> | undefined;
    console.log(m['id'], '| ctx:', limits?.['max_context_window_tokens'], '| category:', m['model_picker_category']);
  });

  // ── Reasoning fields ────────────────────────────────────────────────────
  console.log('\n=== REASONING FIELDS ===');
  models.forEach(m => {
    const caps = m['capabilities'] as Record<string, unknown> | undefined;
    const supports = caps?.['supports'] as Record<string, unknown> | undefined;
    const efforts = supports?.['reasoning_effort'];
    if (efforts !== undefined) {
      console.log(m['id'], '->', JSON.stringify(efforts));
    }
  });

  // Also dump the first model's raw JSON for reference
  console.log('\n=== FIRST MODEL RAW JSON ===');
  console.log(JSON.stringify(models[0], null, 2));
}

main().catch(console.error);

