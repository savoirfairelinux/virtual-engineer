import type { SkillSource } from "./adminProjectsRoutes.js";

export const PRELOADED_PROJECT_SKILL_SOURCE: SkillSource = {
  source: "ssh://g1.sfl.io/sfl/agent-skills",
  skills: [],
  installAll: true,
  sshPort: 29419,
};

export function preloadedProjectSkillSources(): SkillSource[] {
  return [{ ...PRELOADED_PROJECT_SKILL_SOURCE, skills: [...PRELOADED_PROJECT_SKILL_SOURCE.skills] }];
}
