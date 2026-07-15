import { readdirSync, statSync } from 'fs';
import { isAbsolute, join, normalize } from 'path';
import { emitEvent } from './providers/events.js';

export const DEFAULT_LOCAL_SKILLS_PATH = '.github/skills';

export function copilotGlobalSkillsDir(): string {
  return join(process.env['HOME'] || '/ve-home', '.copilot', 'skills');
}

export function localSkillsPath(): string {
  const configured = process.env['LOCAL_SKILLS_PATH']?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_LOCAL_SKILLS_PATH;
}

function normalizedWorkspaceRelativeSkillsPath(): string {
  const configured = localSkillsPath();
  const normalized = normalize(configured);
  if (isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    return DEFAULT_LOCAL_SKILLS_PATH;
  }
  return normalized;
}

export function localSkillsDir(cwd: string): string {
  return join(cwd, normalizedWorkspaceRelativeSkillsPath());
}

function listSkillNames(dir: string): string[] {
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export function emitLocalSkillsLoaded(cwd: string): void {
  const path = normalizedWorkspaceRelativeSkillsPath();
  const skills = listSkillNames(localSkillsDir(cwd));
  emitEvent('skills.local_loaded', { path, skills });
}
