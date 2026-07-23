import type { Prompt, PromptType } from "../interfaces.js";

export function assertPromptRole(prompt: Prompt, expectedRole: PromptType): void {
  if (prompt.promptType !== expectedRole) {
    throw new Error(`Prompt '${prompt.id}' is not a ${expectedRole} prompt`);
  }
}