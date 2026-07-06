/**
 * Helpers for applying a configured Virtual Engineer identity to outward-facing
 * text (review comments, ticket bodies, notifications).
 *
 * When a workflow (project) has no identity bound, these helpers are no-ops so
 * VE keeps its existing default behaviour.
 */

import type { IdentityRecord } from "../interfaces.js";

/** Minimal store surface needed to resolve a project's identity. */
export interface IdentityLookup {
  getIdentityById(id: import("../interfaces.js").IdentityId): Promise<IdentityRecord | null>;
}

/**
 * Resolve the identity bound to a workflow, if any. Returns null when the
 * project is null, has no identity configured, or the identity was deleted.
 */
export async function resolveProjectIdentity(
  store: IdentityLookup,
  project: { identityId: string | null } | null | undefined
): Promise<IdentityRecord | null> {
  if (!project || !project.identityId) return null;
  return store.getIdentityById(project.identityId as import("../interfaces.js").IdentityId);
}

/**
 * Append the identity's signature to a message body. Returns the body unchanged
 * when there is no identity or the identity has no signature. Idempotent — the
 * signature is not appended twice.
 */
export function applyIdentitySignature(body: string, identity: IdentityRecord | null | undefined): string {
  if (!identity) return body;
  const signature = identity.signature.trim();
  if (signature.length === 0) return body;
  if (body.includes(signature)) return body;
  const trimmed = body.replace(/\s+$/, "");
  return trimmed.length === 0 ? signature : `${trimmed}\n\n${signature}`;
}
