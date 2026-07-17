import { readFileSync } from 'fs';

export type SystemPromptSource = 'base64' | 'env';
export type UserPromptSource = 'file';

export interface WorkerPrompts {
  systemPrompt: string;
  userPrompt: string;
  systemPromptSource: SystemPromptSource;
  userPromptSource: UserPromptSource;
}

export type PromptFileReader = (path: string, encoding: 'utf8') => string;

/** Load and validate the prompt transports provided to the agent worker. */
export function loadWorkerPrompts(
  env: NodeJS.ProcessEnv = process.env,
  readFile: PromptFileReader = readFileSync,
): WorkerPrompts {
  const encodedSystemPrompt = env['SYSTEM_PROMPT_BASE64'];
  const inlineSystemPrompt = env['SYSTEM_PROMPT'];
  const systemPrompt = encodedSystemPrompt
    ? Buffer.from(encodedSystemPrompt, 'base64').toString('utf8')
    : (inlineSystemPrompt ?? '');
  if (!systemPrompt.trim()) {
    throw new Error('SYSTEM_PROMPT or SYSTEM_PROMPT_BASE64 env var is required');
  }

  const userPromptFile = env['USER_PROMPT_FILE'];
  if (!userPromptFile) {
    throw new Error('USER_PROMPT_FILE env var is required');
  }

  let userPrompt: string;
  try {
    userPrompt = readFile(userPromptFile, 'utf8').trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read user prompt file: ${message}`);
  }
  if (!userPrompt) {
    throw new Error(`User prompt file is empty: ${userPromptFile}`);
  }

  return {
    systemPrompt,
    userPrompt,
    systemPromptSource: encodedSystemPrompt ? 'base64' : 'env',
    userPromptSource: 'file',
  };
}