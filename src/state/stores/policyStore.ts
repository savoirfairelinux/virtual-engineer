import { randomUUID } from "crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { Permission, Policy, PolicyBinding, PolicyRule, PrincipalType } from "../../interfaces.js";
import { groupMembers, policyBindings, policyRules, policies } from "../schema.js";
import * as schema from "../schema.js";

function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

function duplicateError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "DUPLICATE" });
}

/** A rule to persist within a policy. */
export interface PolicyRuleInput {
  permission: Permission;
  resourceId?: string | null;
}

export interface PolicyStoreApi {
  createPolicy(input: { id?: string; name: string; description?: string; builtin?: boolean }): Promise<Policy>;
  getPolicyById(id: string): Promise<Policy | null>;
  listPolicies(): Promise<Policy[]>;
  updatePolicy(id: string, partial: { name?: string; description?: string }): Promise<Policy | null>;
  /** Delete a policy (cascades its rules and bindings). Returns false when absent. */
  deletePolicy(id: string): Promise<boolean>;

  /** Replace the full rule set of a policy atomically. */
  setPolicyRules(policyId: string, rules: readonly PolicyRuleInput[]): Promise<PolicyRule[]>;
  listPolicyRules(policyId: string): Promise<PolicyRule[]>;

  /** Bind a policy to a principal. Throws `code = "DUPLICATE"` when already bound. */
  createBinding(input: { id?: string; policyId: string; principalType: PrincipalType; principalId: string }): Promise<PolicyBinding>;
  deleteBinding(policyId: string, principalType: PrincipalType, principalId: string): Promise<boolean>;
  listBindingsForPolicy(policyId: string): Promise<PolicyBinding[]>;
  listBindingsForPrincipal(principalType: PrincipalType, principalId: string): Promise<PolicyBinding[]>;

  /**
   * The union of every policy rule that applies to a user: rules of policies
   * bound directly to the user plus rules of policies bound to any group the
   * user belongs to. Drives {@link buildEffectivePermissions}.
   */
  getEffectivePolicyRulesForUser(userId: string): Promise<PolicyRule[]>;
}

interface PolicyStoreContext {
  db: BetterSQLite3Database<typeof schema>;
}

export function createPolicyStore(context: PolicyStoreContext): PolicyStoreApi {
  const { db } = context;

  function rowToPolicy(row: typeof policies.$inferSelect): Policy {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      builtin: row.builtin === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function rowToRule(row: typeof policyRules.$inferSelect): PolicyRule {
    return {
      id: row.id,
      policyId: row.policyId,
      permission: row.permission,
      resourceId: row.resourceId,
      createdAt: row.createdAt,
    };
  }

  function rowToBinding(row: typeof policyBindings.$inferSelect): PolicyBinding {
    return {
      id: row.id,
      policyId: row.policyId,
      principalType: row.principalType,
      principalId: row.principalId,
      createdAt: row.createdAt,
    };
  }

  return {
    async createPolicy(input): Promise<Policy> {
      const now = new Date();
      const row = {
        id: input.id ?? randomUUID(),
        name: input.name,
        description: input.description ?? "",
        builtin: input.builtin ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await db.insert(policies).values(row);
      } catch (err) {
        if (isUniqueConstraintViolation(err)) {
          throw duplicateError(`Policy name already exists: ${input.name}`);
        }
        throw err;
      }
      return rowToPolicy(row);
    },

    async getPolicyById(id): Promise<Policy | null> {
      const row = await db.query.policies.findFirst({ where: eq(policies.id, id) });
      return row ? rowToPolicy(row) : null;
    },

    async listPolicies(): Promise<Policy[]> {
      const rows = await db.query.policies.findMany({ orderBy: policies.name });
      return rows.map(rowToPolicy);
    },

    async updatePolicy(id, partial): Promise<Policy | null> {
      const existing = await db.query.policies.findFirst({ where: eq(policies.id, id) });
      if (!existing) return null;
      const next = {
        name: partial.name ?? existing.name,
        description: partial.description ?? existing.description,
        updatedAt: new Date(),
      };
      try {
        await db.update(policies).set(next).where(eq(policies.id, id));
      } catch (err) {
        if (isUniqueConstraintViolation(err)) {
          throw duplicateError(`Policy name already exists: ${partial.name ?? existing.name}`);
        }
        throw err;
      }
      return rowToPolicy({ ...existing, ...next });
    },

    async deletePolicy(id): Promise<boolean> {
      const result = await db.delete(policies).where(eq(policies.id, id));
      return result.changes > 0;
    },

    async setPolicyRules(policyId, rules): Promise<PolicyRule[]> {
      const now = new Date();
      const rows = rules.map((r) => ({
        id: randomUUID(),
        policyId,
        permission: r.permission,
        resourceId: r.resourceId ?? null,
        createdAt: now,
      }));
      db.transaction((tx) => {
        tx.delete(policyRules).where(eq(policyRules.policyId, policyId)).run();
        if (rows.length > 0) tx.insert(policyRules).values(rows).run();
      });
      return rows.map(rowToRule);
    },

    async listPolicyRules(policyId): Promise<PolicyRule[]> {
      const rows = await db.query.policyRules.findMany({ where: eq(policyRules.policyId, policyId) });
      return rows.map(rowToRule);
    },

    async createBinding(input): Promise<PolicyBinding> {
      const row = {
        id: input.id ?? randomUUID(),
        policyId: input.policyId,
        principalType: input.principalType,
        principalId: input.principalId,
        createdAt: new Date(),
      };
      try {
        await db.insert(policyBindings).values(row);
      } catch (err) {
        if (isUniqueConstraintViolation(err)) {
          throw duplicateError("Policy is already bound to this principal");
        }
        throw err;
      }
      return rowToBinding(row);
    },

    async deleteBinding(policyId, principalType, principalId): Promise<boolean> {
      const result = await db
        .delete(policyBindings)
        .where(
          and(
            eq(policyBindings.policyId, policyId),
            eq(policyBindings.principalType, principalType),
            eq(policyBindings.principalId, principalId)
          )
        );
      return result.changes > 0;
    },

    async listBindingsForPolicy(policyId): Promise<PolicyBinding[]> {
      const rows = await db.query.policyBindings.findMany({ where: eq(policyBindings.policyId, policyId) });
      return rows.map(rowToBinding);
    },

    async listBindingsForPrincipal(principalType, principalId): Promise<PolicyBinding[]> {
      const rows = await db.query.policyBindings.findMany({
        where: and(
          eq(policyBindings.principalType, principalType),
          eq(policyBindings.principalId, principalId)
        ),
      });
      return rows.map(rowToBinding);
    },

    async getEffectivePolicyRulesForUser(userId): Promise<PolicyRule[]> {
      const memberships = await db.query.groupMembers.findMany({ where: eq(groupMembers.userId, userId) });
      const groupIds = memberships.map((m) => m.groupId);

      const principalMatch =
        groupIds.length > 0
          ? or(
              and(eq(policyBindings.principalType, "user"), eq(policyBindings.principalId, userId)),
              and(eq(policyBindings.principalType, "group"), inArray(policyBindings.principalId, groupIds))
            )
          : and(eq(policyBindings.principalType, "user"), eq(policyBindings.principalId, userId));

      const boundPolicies = await db
        .select({ policyId: policyBindings.policyId })
        .from(policyBindings)
        .where(principalMatch);

      const policyIds = Array.from(new Set(boundPolicies.map((b) => b.policyId)));
      if (policyIds.length === 0) return [];

      const rows = await db.query.policyRules.findMany({
        where: inArray(policyRules.policyId, policyIds),
      });
      return rows.map(rowToRule);
    },
  };
}
