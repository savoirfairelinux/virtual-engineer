import type { Prompt, PromptType } from "../interfaces.js";

export function assertPromptRole(prompt: Prompt, expectedRole: PromptType): void {
  if (prompt.promptType !== expectedRole) {
    const article = expectedRole === "instructions" ? "an" : "a";
    throw new Error(`Prompt '${prompt.id}' is not ${article} ${expectedRole} prompt`);
  }
}