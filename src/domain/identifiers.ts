export type TaskId = string & { readonly __brand: "TaskId" };
export type TicketId = string & { readonly __brand: "TicketId" };
export type ExternalChangeId = string & { readonly __brand: "ExternalChangeId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type ProjectId = string & { readonly __brand: "ProjectId" };

export function makeTaskId(value: string): TaskId {
  return value as TaskId;
}

export function makeTicketId(value: string): TicketId {
  return value as TicketId;
}

export function makeExternalChangeId(value: string): ExternalChangeId {
  return value as ExternalChangeId;
}

export function makeAgentId(value: string): AgentId {
  return value as AgentId;
}

export function makeProjectId(value: string): ProjectId {
  return value as ProjectId;
}

/** A hosted review id qualified by its repository, e.g. `owner/repo#42` or `group/project#7`. */
export interface QualifiedChangeId {
  repository: string;
  changeId: string;
}

/** Split a repository-qualified hosted review id; unqualified ids (Gerrit Change-Ids) return null. */
export function parseQualifiedChangeId(value: string): QualifiedChangeId | null {
  const separator = value.lastIndexOf("#");
  if (separator <= 0 || separator === value.length - 1) return null;
  return { repository: value.slice(0, separator), changeId: value.slice(separator + 1) };
}

/** GitHub and GitLab resolve repository paths case-insensitively. */
export function isSameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}