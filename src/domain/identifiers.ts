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