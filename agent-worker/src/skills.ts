import { join } from 'path';

export function copilotGlobalSkillsDir(): string {
  return join(process.env['HOME'] || '/ve-home', '.copilot', 'skills');
}
