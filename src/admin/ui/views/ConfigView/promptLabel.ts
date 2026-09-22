import type { ApiPrompt } from "../../types.ts";

export function promptLabel(prompt: ApiPrompt, prompts: readonly ApiPrompt[]): string {
  if (!prompts.some(candidate => candidate.id !== prompt.id && candidate.label === prompt.label)) {
    return prompt.label;
  }
  return `${prompt.label} (${prompt.builtin ? "built-in" : prompt.id})`;
}