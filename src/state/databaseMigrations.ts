import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";

interface SqliteNameRow {
  name: string;
}

interface SqliteMasterRow {
  name: string;
  sql: string | null;
}

interface SqliteTriggerRow extends SqliteMasterRow {
  tbl_name: string;
}

interface SqliteSequenceRow {
  seq: number;
}

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface IndexListRow {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexColumnRow {
  seqno: number;
  cid: number;
  name: string | null;
  desc: number;
  coll: string;
  key: number;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface ForeignKeyCheckRow {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

interface CanonicalTable {
  name: string;
  sql: string;
  columns: TableInfoRow[];
  indexes: IndexDefinition[];
  foreignKeys: ForeignKeyRow[];
  checks: string[];
  autoincrement: boolean;
}

interface IndexDefinition {
  name: string;
  unique: number;
  origin: string;
  partial: number;
  columns: IndexColumnRow[];
  sql: string | null;
}

interface LedgerRow {
  hash: string;
  created_at: number;
}

interface LegacyTicketSourceRow {
  id: number;
  project_id: string;
  integration_id: string;
  ticket_project_key: string;
  created_at: number;
}

interface LegacyReviewIntegrationRow {
  project_id: string;
  integration_id: string;
  created_at: number;
  updated_at: number;
}

interface LegacyReviewRepoRow {
  project_id: string;
  repo_key: string;
}

const LEGACY_TABLES = new Set([
  "agent_cycles",
  "agents",
  "app_concurrency",
  "app_settings",
  "audit_log",
  "change_per_repository",
  "gitlab_oauth_apps",
  "group_members",
  "groups",
  "integrations",
  "managed_openshell_providers",
  "oauth_apps",
  "policies",
  "policy_bindings",
  "policy_denial_events",
  "policy_rules",
  "posted_review_comments",
  "processed_comments",
  "project_integration_bindings",
  "project_push_targets",
  "project_review_integration",
  "project_review_repos",
  "project_ticket_source",
  "project_vendor_components",
  "projects",
  "prompts",
  "review_thread_replies",
  "state_transitions",
  "tasks",
  "user_sessions",
  "users",
]);

const LEGACY_SIGNATURES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["tasks", ["task_id", "ticket_id", "state", "created_at", "updated_at"]],
  ["projects", ["id", "name", "type", "agent_id", "created_at", "updated_at"]],
  ["prompts", ["id", "label", "content", "created_at", "updated_at"]],
  ["agents", ["id", "name", "type", "model_config_json", "created_at", "updated_at"]],
  ["integrations", ["id", "provider", "name", "config_json", "created_at", "updated_at"]],
  ["gitlab_oauth_apps", ["base_url", "client_id", "created_at", "updated_at"]],
];

const RETIRED_LEGACY_COLUMNS = new Map<string, ReadonlySet<string>>([
  ["projects", new Set(["skill_discovery_enabled", "local_skills_path"])],
  ["project_vendor_components", new Set(["note", "integration_id", "repo_key"])],
]);

const PREDECESSOR_TABLE_COLUMNS = new Map<string, ReadonlyArray<Pick<TableInfoRow, "name" | "type" | "pk">>>([
  ["project_ticket_source", [
    { name: "id", type: "INTEGER", pk: 1 },
    { name: "project_id", type: "TEXT", pk: 0 },
    { name: "integration_id", type: "TEXT", pk: 0 },
    { name: "ticket_project_key", type: "TEXT", pk: 0 },
    { name: "created_at", type: "INTEGER", pk: 0 },
  ]],
  ["project_review_integration", [
    { name: "project_id", type: "TEXT", pk: 1 },
    { name: "integration_id", type: "TEXT", pk: 0 },
  ]],
  ["project_review_repos", [
    { name: "id", type: "INTEGER", pk: 1 },
    { name: "project_id", type: "TEXT", pk: 0 },
    { name: "repo_key", type: "TEXT", pk: 0 },
  ]],
]);

export function runDatabaseMigrations(raw: Database.Database): void {
  const migrationsFolder = resolveMigrationsFolder();
  const migrations = readMigrationFiles({ migrationsFolder });
  if (migrations.length === 0) throw new Error("Tracked Drizzle journal contains no migrations");

  const canonical = createCanonicalDatabase(migrationsFolder);
  try {
    const userTables = listUserTables(raw);
    if (userTables.has("__drizzle_migrations")) {
      validateLedger(raw, migrations);
    } else if (userTables.size > 0) {
      assertRecognizedLegacyDatabase(raw, userTables);
      adoptLegacyDatabase(raw, canonical, migrations[0], userTables);
    }

    migrate(drizzle(raw), { migrationsFolder });
    validateCanonicalSchema(raw, canonical);
    validateForeignKeys(raw);
  } finally {
    canonical.close();
  }
}

function resolveMigrationsFolder(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, "../../drizzle"),
    resolve(moduleDir, "../../../drizzle"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "meta", "_journal.json"))) return candidate;
  }
  throw new Error(`Unable to locate tracked Drizzle migrations; checked: ${candidates.join(", ")}`);
}

function createCanonicalDatabase(migrationsFolder: string): Database.Database {
  const canonical = new Database(":memory:");
  canonical.pragma("foreign_keys = ON");
  try {
    migrate(drizzle(canonical), { migrationsFolder });
    return canonical;
  } catch (error) {
    canonical.close();
    throw error;
  }
}

function listUserTables(raw: Database.Database): Set<string> {
  const rows = raw.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all() as SqliteNameRow[];
  return new Set(rows.map((row) => row.name));
}

function validateLedger(raw: Database.Database, migrations: MigrationMeta[]): void {
  let rows: LedgerRow[];
  try {
    rows = raw.prepare(`
      SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at, rowid
    `).all() as LedgerRow[];
  } catch (error) {
    throw new Error("Invalid Drizzle migration ledger schema", { cause: error });
  }
  if (rows.length > migrations.length) {
    throw new Error("Drizzle migration ledger contains unknown or future entries");
  }
  for (const [index, row] of rows.entries()) {
    const expected = migrations[index];
    if (expected === undefined || row.created_at !== expected.folderMillis || row.hash !== expected.hash) {
      throw new Error(`Drizzle migration ledger entry ${index} does not match tracked history`);
    }
  }
}

function assertRecognizedLegacyDatabase(raw: Database.Database, tables: Set<string>): void {
  const unknownTables = [...tables].filter((table) => !LEGACY_TABLES.has(table));
  const recognized = LEGACY_SIGNATURES.some(([table, requiredColumns]) => {
    if (!tables.has(table)) return false;
    const columns = new Set(tableColumns(raw, table));
    return requiredColumns.every((column) => columns.has(column));
  });
  if (!recognized || unknownTables.length > 0) {
    const suffix = unknownTables.length > 0 ? `: ${unknownTables.join(", ")}` : "";
    throw new Error(`Unrecognized ledgerless database${suffix}`);
  }
}

function adoptLegacyDatabase(
  raw: Database.Database,
  canonical: Database.Database,
  baseline: Pick<MigrationMeta, "hash" | "folderMillis"> | undefined,
  originalTables: ReadonlySet<string>
): void {
  if (baseline === undefined) throw new Error("Tracked Drizzle baseline is missing");
  const foreignKeysEnabled = raw.pragma("foreign_keys", { simple: true }) === 1;
  if (foreignKeysEnabled) raw.pragma("foreign_keys = OFF");
  try {
    raw.transaction(() => {
      validateLegacySemantics(raw, canonical, originalTables);
      applyLegacyCompatibilityMigration(raw);
      canonicalizeLegacyTables(raw, canonical);
      raw.exec(`
        CREATE TABLE __drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at numeric
        )
      `);
      raw.prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)"
      ).run(baseline.hash, baseline.folderMillis);
      installCanonicalTriggers(raw, canonical);
      validateCanonicalSchema(raw, canonical);
      validateForeignKeys(raw);
    })();
  } finally {
    if (foreignKeysEnabled) raw.pragma("foreign_keys = ON");
  }
}

export function adoptLegacyDatabaseForTest(
  raw: Database.Database,
  canonical: Database.Database,
  baseline: Pick<MigrationMeta, "hash" | "folderMillis">
): void {
  adoptLegacyDatabase(raw, canonical, baseline, listUserTables(raw));
}

function validateCanonicalSchema(raw: Database.Database, canonical: Database.Database): void {
  const errors = compareCanonicalSchema(raw, canonical);
  if (errors.length > 0) {
    throw new Error(`Canonical schema validation failed: ${errors.join("; ")}`);
  }
}

function compareCanonicalSchema(
  raw: Database.Database,
  canonical: Database.Database
): string[] {
  const errors: string[] = [];
  const expectedTables = readCanonicalTables(canonical);
  const expectedNames = new Set(expectedTables.map((table) => table.name));
  const actualNames = [...listUserTables(raw)]
    .filter((table) => table !== "__drizzle_migrations")
    .sort();
  const unexpectedTables = actualNames.filter((table) => !expectedNames.has(table));
  if (unexpectedTables.length > 0) {
    errors.push(`unexpected tables: ${unexpectedTables.join(", ")}`);
  }
  for (const expected of expectedTables) {
    errors.push(...compareTable(raw, expected));
  }
  errors.push(...compareTriggers(raw, canonical));
  return errors;
}

function compareTriggers(raw: Database.Database, canonical: Database.Database): string[] {
  const actual = readTriggers(raw);
  const expected = readTriggers(canonical);
  const expectedByName = new Map(expected.map((trigger) => [trigger.name, trigger]));
  const errors: string[] = [];
  for (const trigger of actual) {
    const expectedTrigger = expectedByName.get(trigger.name);
    if (expectedTrigger === undefined) {
      errors.push(`unexpected triggers: ${trigger.name}`);
      continue;
    }
    if (triggerSignature(trigger) !== triggerSignature(expectedTrigger)) {
      errors.push(`trigger semantics differ for ${trigger.name}`);
    }
  }
  const actualNames = new Set(actual.map((trigger) => trigger.name));
  for (const trigger of expected) {
    if (!actualNames.has(trigger.name)) errors.push(`missing trigger ${trigger.name}`);
  }
  return errors;
}

function readTriggers(raw: Database.Database): SqliteTriggerRow[] {
  return raw.prepare(`
    SELECT name, tbl_name, sql FROM sqlite_master
    WHERE type = 'trigger' ORDER BY name
  `).all() as SqliteTriggerRow[];
}

function installCanonicalTriggers(raw: Database.Database, canonical: Database.Database): void {
  for (const trigger of readTriggers(canonical)) {
    if (trigger.sql === null) {
      throw new Error(`Canonical trigger ${trigger.name} has no SQL definition`);
    }
    raw.exec(trigger.sql);
  }
}

function triggerSignature(trigger: SqliteTriggerRow): string {
  return JSON.stringify({
    table: trigger.tbl_name,
    sql: trigger.sql === null
      ? null
      : trigger.sql.replaceAll(/[`"\[\]]/g, "").replaceAll(/\s+/g, " ").trim().toLowerCase(),
  });
}

function readCanonicalTables(canonical: Database.Database): CanonicalTable[] {
  const rows = canonical.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations'
    ORDER BY name
  `).all() as SqliteMasterRow[];
  return rows.map((row) => {
    if (row.sql === null) throw new Error(`Canonical table ${row.name} has no SQL definition`);
    return readTableDefinition(canonical, row.name, row.sql);
  });
}

function readTableDefinition(
  raw: Database.Database,
  tableName: string,
  tableSql: string
): CanonicalTable {
  const indexes = (raw.prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`).all() as IndexListRow[])
    .map((index) => readIndexDefinition(raw, index));
  return {
    name: tableName,
    sql: tableSql,
    columns: raw.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as TableInfoRow[],
    indexes,
    foreignKeys: raw.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`).all() as ForeignKeyRow[],
    checks: extractCheckExpressions(tableSql, tableName),
    autoincrement: /\bAUTOINCREMENT\b/i.test(tableSql),
  };
}

function readIndexDefinition(raw: Database.Database, index: IndexListRow): IndexDefinition {
  const row = raw.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = ?"
  ).get(index.name) as SqliteMasterRow | undefined;
  return {
    name: index.name,
    unique: index.unique,
    origin: index.origin,
    partial: index.partial,
    columns: raw.prepare(`PRAGMA index_xinfo(${quoteIdentifier(index.name)})`).all() as IndexColumnRow[],
    sql: row?.sql ?? null,
  };
}

function compareTable(raw: Database.Database, expected: CanonicalTable): string[] {
  const row = raw.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(expected.name) as SqliteMasterRow | undefined;
  if (row?.sql === null || row?.sql === undefined) return [`missing table ${expected.name}`];

  const actual = readTableDefinition(raw, expected.name, row.sql);
  const errors: string[] = [];
  if (JSON.stringify(normalizeColumns(actual.columns)) !== JSON.stringify(normalizeColumns(expected.columns))) {
    errors.push(`column semantics differ for ${expected.name}`);
  }
  if (actual.autoincrement !== expected.autoincrement) {
    errors.push(`AUTOINCREMENT differs for ${expected.name}`);
  }
  if (JSON.stringify(normalizeForeignKeys(actual.foreignKeys)) !== JSON.stringify(normalizeForeignKeys(expected.foreignKeys))) {
    errors.push(`foreign keys differ for ${expected.name}`);
  }
  if (JSON.stringify(actual.checks) !== JSON.stringify(expected.checks)) {
    errors.push(`CHECK constraints differ for ${expected.name}`);
  }
  errors.push(...compareIndexes(actual, expected));
  return errors;
}

function normalizeColumns(columns: TableInfoRow[]): Array<Record<string, string | number | null>> {
  return columns.map((column) => ({
    name: column.name,
    type: column.type.trim().toLowerCase(),
    notnull: column.notnull,
    default: normalizeSqlFragment(column.dflt_value),
    pk: column.pk,
  }));
}

function normalizeForeignKeys(rows: ForeignKeyRow[]): ForeignKeyRow[] {
  return rows.map((row) => ({
    ...row,
    on_update: row.on_update.toLowerCase(),
    on_delete: row.on_delete.toLowerCase(),
    match: row.match.toLowerCase(),
  })).sort((left, right) => left.id - right.id || left.seq - right.seq);
}

function compareIndexes(actual: CanonicalTable, expected: CanonicalTable): string[] {
  const errors: string[] = [];
  const actualNamed = new Map(actual.indexes
    .filter((index) => !index.name.startsWith("sqlite_autoindex_"))
    .map((index) => [index.name, index]));
  for (const expectedIndex of expected.indexes.filter((index) => !index.name.startsWith("sqlite_autoindex_"))) {
    const actualIndex = actualNamed.get(expectedIndex.name);
    if (actualIndex === undefined) {
      errors.push(`missing index ${expectedIndex.name}`);
      continue;
    }
    if (indexSignature(actualIndex, actual.name) !== indexSignature(expectedIndex, expected.name)) {
      errors.push(`index semantics differ for ${expectedIndex.name}`);
    }
  }
  const expectedNamed = new Set(expected.indexes
    .filter((index) => !index.name.startsWith("sqlite_autoindex_"))
    .map((index) => index.name));
  const unexpectedIndexes = [...actualNamed.keys()]
    .filter((indexName) => !expectedNamed.has(indexName))
    .sort();
  if (unexpectedIndexes.length > 0) {
    errors.push(`unexpected indexes for ${expected.name}: ${unexpectedIndexes.join(", ")}`);
  }

  const actualConstraints = actual.indexes
    .filter((index) => index.name.startsWith("sqlite_autoindex_"))
    .map((index) => indexConstraintSignature(index))
    .sort();
  const expectedConstraints = expected.indexes
    .filter((index) => index.name.startsWith("sqlite_autoindex_"))
    .map((index) => indexConstraintSignature(index))
    .sort();
  if (JSON.stringify(actualConstraints) !== JSON.stringify(expectedConstraints)) {
    errors.push(`physical UNIQUE/PRIMARY KEY constraints differ for ${expected.name}`);
  }
  return errors;
}

function indexSignature(index: IndexDefinition, tableName: string): string {
  return JSON.stringify({
    unique: index.unique,
    origin: index.origin,
    partial: index.partial,
    columns: normalizeIndexColumns(index.columns),
    sql: normalizeSqlDefinition(index.sql, tableName),
  });
}

function indexConstraintSignature(index: IndexDefinition): string {
  return JSON.stringify({
    unique: index.unique,
    origin: index.origin,
    partial: index.partial,
    columns: normalizeIndexColumns(index.columns),
  });
}

function normalizeIndexColumns(columns: IndexColumnRow[]): Array<Record<string, string | number | null>> {
  return columns.map((column) => ({
    seqno: column.seqno,
    name: column.name,
    desc: column.desc,
    coll: column.coll.toLowerCase(),
    key: column.key,
  }));
}

function normalizeSqlDefinition(sql: string | null, tableName: string): string | null {
  if (sql === null) return null;
  const unquoted = sql.replaceAll(/[`"\[\]]/g, "").toLowerCase();
  return unquoted
    .replaceAll(tableName.length > 0
      ? new RegExp(`\\b${escapeRegExp(tableName.toLowerCase())}\\.`, "g")
      : /$^/g, "")
    .replaceAll(
      /coalesce\(local_path\s*,\s*''\)/g,
      "case when local_path is null then '' else local_path end"
    )
    .replace(/^create (unique )?index if not exists /, "create $1index ")
    .replaceAll(/\s+/g, " ")
    .replaceAll(/\s*([(),=])\s*/g, "$1")
    .trim();
}

function normalizeSqlFragment(sql: string | null): string | null {
  if (sql === null) return null;
  let normalized = sql.trim().replaceAll(/\s+/g, " ").toLowerCase();
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function extractCheckExpressions(sql: string, tableName: string): string[] {
  const checks: string[] = [];
  const lower = sql.toLowerCase();
  let offset = 0;
  while (offset < sql.length) {
    const checkIndex = lower.indexOf("check", offset);
    if (checkIndex < 0) break;
    const openIndex = sql.indexOf("(", checkIndex + 5);
    if (openIndex < 0) break;
    const closeIndex = findClosingParenthesis(sql, openIndex);
    if (closeIndex < 0) break;
    checks.push(normalizeSqlDefinition(sql.slice(openIndex + 1, closeIndex), tableName) ?? "");
    offset = closeIndex + 1;
  }
  return checks.sort();
}

function findClosingParenthesis(sql: string, openIndex: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = openIndex; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === undefined) break;
    if (quote !== null) {
      if (character === quote && sql[index + 1] === quote) index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function validateForeignKeys(raw: Database.Database): void {
  const violations = raw.pragma("foreign_key_check") as ForeignKeyCheckRow[];
  if (violations.length > 0) {
    const first = violations[0];
    throw new Error(
      `Foreign key validation failed: ${first?.table ?? "unknown"} row ${first?.rowid ?? "unknown"} references ${first?.parent ?? "unknown"}`
    );
  }
}

function validateLegacySemantics(
  raw: Database.Database,
  canonical: Database.Database,
  originalTables: ReadonlySet<string>
): void {
  validatePredecessorTableShapes(raw, originalTables);
  const legacyTriggers = readTriggers(raw);
  if (legacyTriggers.length > 0) {
    throw new Error(
      `Canonical schema validation failed: unexpected triggers: ${legacyTriggers.map((trigger) => trigger.name).join(", ")}`
    );
  }
  for (const expected of readCanonicalTables(canonical)) {
    if (!originalTables.has(expected.name)) continue;
    const row = raw.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(expected.name) as SqliteMasterRow | undefined;
    if (row?.sql === null || row?.sql === undefined) continue;
    const actual = readTableDefinition(raw, expected.name, row.sql);
    const errors = compareLegacyTable(actual, expected);
    if (errors.length > 0) {
      throw new Error(`Canonical schema validation failed: ${errors.join("; ")}`);
    }
  }
}

function canonicalizeLegacyTables(raw: Database.Database, canonical: Database.Database): void {
  for (const expected of readCanonicalTables(canonical)) {
    const row = raw.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(expected.name) as SqliteMasterRow | undefined;
    if (row?.sql === null || row?.sql === undefined) continue;
    rebuildTableFromCanonical(raw, readTableDefinition(raw, expected.name, row.sql), expected);
  }
}

function compareLegacyTable(actual: CanonicalTable, expected: CanonicalTable): string[] {
  const errors: string[] = [];
  const expectedColumns = new Map(expected.columns.map((column) => [column.name, column]));
  const retiredColumns = RETIRED_LEGACY_COLUMNS.get(actual.name) ?? new Set<string>();
  const unexpectedColumns = actual.columns
    .filter((column) => !expectedColumns.has(column.name) && !retiredColumns.has(column.name))
    .map((column) => `${actual.name}.${column.name}`);
  if (unexpectedColumns.length > 0) {
    errors.push(`unexpected legacy columns: ${unexpectedColumns.join(", ")}`);
  }
  for (const actualColumn of actual.columns) {
    const expectedColumn = expectedColumns.get(actualColumn.name);
    if (expectedColumn === undefined) continue;
    if (!legacyColumnMatches(expected.name, actualColumn, expectedColumn)) {
      errors.push(`column semantics differ for ${expected.name}.${actualColumn.name}`);
    }
  }

  const presentColumns = new Set(actual.columns.map((column) => column.name));
  const expectedForeignKeys = normalizeForeignKeySemantics(expected.foreignKeys
    .filter((foreignKey) => presentColumns.has(foreignKey.from)));
  const actualForeignKeys = normalizeForeignKeySemantics(actual.foreignKeys);
  if (JSON.stringify(actualForeignKeys) !== JSON.stringify(expectedForeignKeys)) {
    errors.push(`foreign keys differ for ${expected.name}`);
  }
  if (JSON.stringify(actual.checks) !== JSON.stringify(expected.checks)) {
    errors.push(`CHECK constraints differ for ${expected.name}`);
  }

  const expectedNamed = new Map(expected.indexes
    .filter((index) => !index.name.startsWith("sqlite_autoindex_"))
    .map((index) => [index.name, index]));
  for (const actualIndex of actual.indexes.filter((index) => !index.name.startsWith("sqlite_autoindex_"))) {
    const expectedIndex = expectedNamed.get(actualIndex.name);
    if (expectedIndex !== undefined
      && indexSignature(actualIndex, actual.name) !== indexSignature(expectedIndex, expected.name)) {
      errors.push(`index semantics differ for ${actualIndex.name}`);
    }
  }

  const actualTableConstraints = actual.indexes
    .filter((index) => index.name.startsWith("sqlite_autoindex_"))
    .map(indexConstraintSignature);
  const expectedPrimaryKeys = expected.indexes
    .filter((index) => index.name.startsWith("sqlite_autoindex_") && index.origin === "pk")
    .map(indexConstraintSignature);
  for (const constraint of expectedPrimaryKeys) {
    if (!actualTableConstraints.includes(constraint)) {
      errors.push(`physical PRIMARY KEY constraint differs for ${expected.name}`);
    }
  }
  return errors;
}

function validatePredecessorTableShapes(
  raw: Database.Database,
  originalTables: ReadonlySet<string>
): void {
  for (const [table, expectedColumns] of PREDECESSOR_TABLE_COLUMNS) {
    if (!originalTables.has(table)) continue;
    const actualColumns = raw.prepare(
      `PRAGMA table_info(${quoteIdentifier(table)})`
    ).all() as TableInfoRow[];
    const actualShape = actualColumns.map((column) => ({
      name: column.name,
      type: column.type.trim().toUpperCase(),
      pk: column.pk,
    }));
    if (JSON.stringify(actualShape) !== JSON.stringify(expectedColumns)) {
      throw new Error(
        `Malformed predecessor table ${table}: expected historical columns, types, and primary key`
      );
    }
  }
}

function legacyColumnMatches(
  tableName: string,
  actual: TableInfoRow,
  expected: TableInfoRow
): boolean {
  const primaryKeyNullabilityArtifact = actual.pk > 0
    && actual.notnull === 0
    && expected.notnull === 1;
  const historicalPromptType = tableName === "prompts"
    && actual.name === "prompt_type"
    && actual.type.trim().toLowerCase() === "text"
    && actual.notnull === 0
    && actual.dflt_value === null;
  return actual.name === expected.name
    && actual.type.trim().toLowerCase() === expected.type.trim().toLowerCase()
    && (actual.notnull === expected.notnull || primaryKeyNullabilityArtifact || historicalPromptType)
    && (normalizeSqlFragment(actual.dflt_value) === normalizeSqlFragment(expected.dflt_value)
      || historicalPromptType)
    && actual.pk === expected.pk;
}

function normalizeForeignKeySemantics(rows: ForeignKeyRow[]): Array<Record<string, string | number>> {
  return rows.map((row) => ({
    seq: row.seq,
    table: row.table,
    from: row.from,
    to: row.to,
    onUpdate: row.on_update.toLowerCase(),
    onDelete: row.on_delete.toLowerCase(),
    match: row.match.toLowerCase(),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function rebuildTableFromCanonical(
  raw: Database.Database,
  actual: CanonicalTable,
  expected: CanonicalTable
): void {
  const temporaryName = `__ve_canonical_${expected.name}`;
  const createSql = replaceCreatedTableName(expected.sql, expected.name, temporaryName);
  const columns = expected.columns.map((column) => quoteIdentifier(column.name)).join(", ");
  const previousSequence = actual.autoincrement
    ? raw.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(actual.name) as SqliteSequenceRow | undefined
    : undefined;
  raw.exec(createSql);
  raw.exec(`INSERT INTO ${quoteIdentifier(temporaryName)} (${columns}) SELECT ${columns} FROM ${quoteIdentifier(actual.name)}`);
  raw.exec(`DROP TABLE ${quoteIdentifier(actual.name)}`);
  raw.exec(`ALTER TABLE ${quoteIdentifier(temporaryName)} RENAME TO ${quoteIdentifier(expected.name)}`);
  if (previousSequence !== undefined) {
    const currentSequence = raw.prepare(
      "SELECT seq FROM sqlite_sequence WHERE name = ?"
    ).get(expected.name) as SqliteSequenceRow | undefined;
    const sequence = Math.max(previousSequence.seq, currentSequence?.seq ?? 0);
    const updated = raw.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?")
      .run(sequence, expected.name);
    if (updated.changes === 0) {
      raw.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)")
        .run(expected.name, sequence);
    }
  }
  for (const index of expected.indexes) {
    if (index.sql !== null) raw.exec(index.sql);
  }
}

function replaceCreatedTableName(sql: string, tableName: string, replacement: string): string {
  const tablePattern = new RegExp(
    "^(CREATE TABLE\\s+)([`\"]?)" + escapeRegExp(tableName) + "\\2",
    "i"
  );
  const qualifierPattern = new RegExp(
    "([`\"]?)" + escapeRegExp(tableName) + "\\1\\.",
    "gi"
  );
  return sql
    .replace(tablePattern, `$1${quoteIdentifier(replacement)}`)
    .replaceAll(qualifierPattern, `${quoteIdentifier(replacement)}.`);
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tableColumns(raw: Database.Database, tableName: string): string[] {
  return (raw.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as SqliteNameRow[])
    .map((row) => row.name);
}

function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function applyLegacyCompatibilityMigration(raw: Database.Database): void {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL,
      ticket_source_label TEXT NOT NULL DEFAULT 'redmine', ticket_title TEXT NOT NULL DEFAULT '',
      ticket_description TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'DETECTED',
      gerrit_change_id TEXT, current_patchset INTEGER NOT NULL DEFAULT 0,
      cycle_count INTEGER NOT NULL DEFAULT 0, failure_reason TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS state_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(task_id),
      from_state TEXT NOT NULL, to_state TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(task_id),
      cycle_number INTEGER NOT NULL, agent_result TEXT NOT NULL, validation_result TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS processed_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(task_id),
      gerrit_comment_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posted_review_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(task_id),
      change_id TEXT NOT NULL, comment_hash TEXT NOT NULL, file TEXT NOT NULL,
      line INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL DEFAULT '', provider_thread_id TEXT,
      resolved INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_posted_review_comments_task_id ON posted_review_comments(task_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_posted_review_comments_task_hash ON posted_review_comments(task_id, comment_hash);
    CREATE TABLE IF NOT EXISTS review_thread_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(task_id),
      change_id TEXT NOT NULL, thread_id TEXT NOT NULL, handled_comment_hash TEXT NOT NULL,
      reply_message TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_thread_replies_task_id ON review_thread_replies(task_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_review_thread_replies_task_thread_hash
      ON review_thread_replies(task_id, thread_id, handled_comment_hash);
    CREATE INDEX IF NOT EXISTS idx_tasks_ticket_id ON tasks(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_state_transitions_task_id ON state_transitions(task_id);
    CREATE INDEX IF NOT EXISTS idx_agent_cycles_task_id ON agent_cycles(task_id);
    CREATE INDEX IF NOT EXISTS idx_agent_cycles_created_at ON agent_cycles(created_at);
    CREATE INDEX IF NOT EXISTS idx_processed_comments_task_id ON processed_comments(task_id);
    CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL, config_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gitlab_oauth_apps (
      base_url TEXT PRIMARY KEY, client_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_apps (
      provider TEXT NOT NULL, base_url TEXT NOT NULL, client_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (provider, base_url)
    );
    INSERT OR IGNORE INTO oauth_apps (provider, base_url, client_id, created_at, updated_at)
      SELECT 'gitlab', base_url, client_id, created_at, updated_at FROM gitlab_oauth_apps;
    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, content TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS change_per_repository (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), repo_key TEXT NOT NULL,
      change_id TEXT NOT NULL, review_url TEXT, status TEXT NOT NULL DEFAULT 'OPEN',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_change_per_repo_task_id ON change_per_repository(task_id);
    CREATE INDEX IF NOT EXISTS idx_change_per_repo_task_repo ON change_per_repository(task_id, repo_key);
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      model_config_json TEXT NOT NULL DEFAULT '{}', system_prompt_id TEXT REFERENCES prompts(id),
      instructions_prompt_id TEXT REFERENCES prompts(id), max_concurrent INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
    CREATE INDEX IF NOT EXISTS idx_agents_enabled ON agents(enabled);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id), agent_override_json TEXT,
      post_clone_script TEXT NOT NULL DEFAULT '', skill_sources_json TEXT NOT NULL DEFAULT '[]',
      gerrit_topic_override TEXT, use_full_ticket_url_in_commits INTEGER NOT NULL DEFAULT 0,
      post_review_link_to_ticket INTEGER NOT NULL DEFAULT 0, react_to_ci_failures INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
    CREATE INDEX IF NOT EXISTS idx_projects_enabled ON projects(enabled);
    CREATE TABLE IF NOT EXISTS project_integration_bindings (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      integration_id TEXT NOT NULL REFERENCES integrations(id), capability TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pib_project_capability ON project_integration_bindings(project_id, capability);
    CREATE INDEX IF NOT EXISTS idx_pib_project_id ON project_integration_bindings(project_id);
    CREATE INDEX IF NOT EXISTS idx_pib_capability ON project_integration_bindings(capability);
    CREATE TABLE IF NOT EXISTS project_push_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id),
      integration_id TEXT NOT NULL REFERENCES integrations(id), repo_key TEXT NOT NULL,
      clone_url TEXT NOT NULL, target_branch TEXT NOT NULL, role TEXT NOT NULL,
      commit_order INTEGER NOT NULL, local_path TEXT NOT NULL, ssh_key_path TEXT,
      reviewer_emails TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ppt_project_repo ON project_push_targets(project_id, repo_key);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ppt_project_order ON project_push_targets(project_id, commit_order);
    CREATE INDEX IF NOT EXISTS idx_ppt_project_id ON project_push_targets(project_id);
    CREATE TABLE IF NOT EXISTS project_vendor_components (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id),
      source_path TEXT NOT NULL, local_path TEXT, clone_url TEXT, revision TEXT, origin TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pvc_project_source_local
      ON project_vendor_components(project_id, source_path, COALESCE(local_path, ''));
    DROP INDEX IF EXISTS uq_pvc_project_source_path;
    CREATE INDEX IF NOT EXISTS idx_pvc_project_id ON project_vendor_components(project_id);
    CREATE TABLE IF NOT EXISTS app_concurrency (
      id TEXT PRIMARY KEY CHECK (id = 'global'), max_concurrent INTEGER, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      id TEXT PRIMARY KEY CHECK (id = 'global'), polling_interval_ms INTEGER,
      max_agent_cycles INTEGER, max_retry_attempts INTEGER, agent_timeout_ms INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(username);
    CREATE TABLE IF NOT EXISTS user_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS user_sessions_token_hash_unique ON user_sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id TEXT, actor_name TEXT NOT NULL,
      action TEXT NOT NULL, target_type TEXT, target_id TEXT, details_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action_created_at ON audit_log(action, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_actor_created_at ON audit_log(actor_name, created_at);
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS groups_name_unique ON groups(name);
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, PRIMARY KEY (group_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_group_members_user_id ON group_members(user_id);
    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
      builtin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS policies_name_unique ON policies(name);
    CREATE TABLE IF NOT EXISTS policy_rules (
      id TEXT PRIMARY KEY, policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
      permission TEXT NOT NULL, resource_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_policy_rules_policy_id ON policy_rules(policy_id);
    CREATE INDEX IF NOT EXISTS idx_policy_rules_permission ON policy_rules(permission);
    CREATE TABLE IF NOT EXISTS policy_bindings (
      id TEXT PRIMARY KEY, policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
      principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_bindings ON policy_bindings(policy_id, principal_type, principal_id);
    CREATE INDEX IF NOT EXISTS idx_policy_bindings_principal ON policy_bindings(principal_type, principal_id);
  `);

  ensureLegacyColumns(raw);
  raw.exec(`
    UPDATE prompts SET prompt_type = 'instructions'
      WHERE prompt_type IS NULL OR prompt_type NOT IN ('system', 'instructions');
    UPDATE prompts SET prompt_type = 'system' WHERE id IN ('system_generic_code', 'system_review');
    UPDATE prompts SET prompt_type = 'instructions'
      WHERE id IN ('instructions_generic_code', 'instructions_feedback_code', 'instructions_review');
  `);
  migrateReferencedPromptRoles(raw);
  migratePredecessorBindings(raw);
  raw.exec(`
    DROP INDEX IF EXISTS idx_tasks_active_ticket_id;
    CREATE UNIQUE INDEX idx_tasks_active_ticket_id ON tasks(project_id, ticket_id)
      WHERE state NOT IN ('DONE', 'FAILED', 'ABANDONED', 'REVIEW_DONE', 'REVIEW_FAILED');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_ticket_id_noproject ON tasks(ticket_id)
      WHERE project_id IS NULL
        AND state NOT IN ('DONE', 'FAILED', 'ABANDONED', 'REVIEW_DONE', 'REVIEW_FAILED');
    DROP TABLE IF EXISTS project_review_repos;
    DROP TABLE IF EXISTS project_review_integration;
    DROP TABLE IF EXISTS project_ticket_source;
    DROP TABLE IF EXISTS policy_denial_events;
    DROP TABLE IF EXISTS managed_openshell_providers;
  `);
}

function migratePredecessorBindings(raw: Database.Database): void {
  const tables = listUserTables(raw);
  const insert = raw.prepare(`
    INSERT INTO project_integration_bindings (
      id, project_id, integration_id, capability, config_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  if (tables.has("project_ticket_source")) {
    const ticketSources = raw.prepare(`
      SELECT id, project_id, integration_id, ticket_project_key, created_at
      FROM project_ticket_source ORDER BY id
    `).all() as LegacyTicketSourceRow[];
    for (const source of ticketSources) {
      insert.run(
        `legacy:project_ticket_source:${source.id}`,
        source.project_id,
        source.integration_id,
        "issue_tracking",
        JSON.stringify({ ticketProjectKey: source.ticket_project_key }),
        source.created_at,
        source.created_at
      );
    }
  }

  if (tables.has("project_review_integration")) {
    const orphanedReviewProjects = (raw.prepare(`
      SELECT pri.project_id
      FROM project_review_integration pri
      LEFT JOIN projects p ON p.id = pri.project_id
      WHERE p.id IS NULL
      ORDER BY pri.project_id
    `).all() as LegacyReviewRepoRow[]).map((review) => review.project_id);
    if (orphanedReviewProjects.length > 0) {
      throw new Error(
        `Legacy review integrations exist without a project: ${orphanedReviewProjects.join(", ")}`
      );
    }
    const reviewIntegrations = raw.prepare(`
      SELECT pri.project_id, pri.integration_id, p.created_at, p.updated_at
      FROM project_review_integration pri
      JOIN projects p ON p.id = pri.project_id
      ORDER BY pri.project_id
    `).all() as LegacyReviewIntegrationRow[];
    const reviewRepos = tables.has("project_review_repos")
      ? raw.prepare(`
          SELECT project_id, repo_key FROM project_review_repos
          ORDER BY project_id, repo_key
        `).all() as LegacyReviewRepoRow[]
      : [];
    const reposByProject = new Map<string, Set<string>>();
    for (const repo of reviewRepos) {
      const repos = reposByProject.get(repo.project_id) ?? new Set<string>();
      repos.add(repo.repo_key);
      reposByProject.set(repo.project_id, repos);
    }
    const reviewProjects = new Set(reviewIntegrations.map((review) => review.project_id));
    const orphanedRepoProjects = [...reposByProject.keys()]
      .filter((projectId) => !reviewProjects.has(projectId))
      .sort();
    if (orphanedRepoProjects.length > 0) {
      throw new Error(
        `Legacy review repositories exist without a review integration: ${orphanedRepoProjects.join(", ")}`
      );
    }
    for (const review of reviewIntegrations) {
      insert.run(
        `legacy:project_review_integration:${review.project_id}`,
        review.project_id,
        review.integration_id,
        "code_review",
        JSON.stringify({ repos: [...(reposByProject.get(review.project_id) ?? [])].sort() }),
        review.created_at,
        review.updated_at
      );
    }
  } else if (tables.has("project_review_repos")) {
    const orphanedRepoProjects = (raw.prepare(`
      SELECT DISTINCT project_id FROM project_review_repos ORDER BY project_id
    `).all() as LegacyReviewRepoRow[]).map((repo) => repo.project_id);
    if (orphanedRepoProjects.length > 0) {
      throw new Error(
        `Legacy review repositories exist without a review integration: ${orphanedRepoProjects.join(", ")}`
      );
    }
  }
}

function ensureLegacyColumns(raw: Database.Database): void {
  const additions: ReadonlyArray<readonly [string, string, string]> = [
    ["tasks", "ticket_source_label", "TEXT NOT NULL DEFAULT 'redmine'"],
    ["tasks", "ticket_title", "TEXT NOT NULL DEFAULT ''"],
    ["tasks", "ticket_description", "TEXT NOT NULL DEFAULT ''"],
    ["tasks", "ticket_url", "TEXT"], ["tasks", "review_url", "TEXT"],
    ["tasks", "task_type", "TEXT NOT NULL DEFAULT 'code-gen'"],
    ["tasks", "reviewed_patchset", "INTEGER"], ["tasks", "project_id", "TEXT"],
    ["tasks", "display_id", "TEXT"], ["tasks", "ticket_source_integration_id", "TEXT"],
    ["tasks", "ticket_source_project_key", "TEXT"], ["tasks", "push_ref", "TEXT"],
    ["change_per_repository", "integration_id", "TEXT NOT NULL DEFAULT ''"],
    ["change_per_repository", "review_system", "TEXT NOT NULL DEFAULT ''"],
    ["change_per_repository", "commit_index", "INTEGER NOT NULL DEFAULT 0"],
    ["change_per_repository", "subject_hash", "TEXT"],
    ["agent_cycles", "agent_events", "TEXT"], ["agent_cycles", "cost_ai_credits", "REAL"],
    ["agent_cycles", "cost_usd", "REAL"], ["agent_cycles", "premium_requests", "REAL"],
    ["agent_cycles", "cost_input_tokens", "INTEGER"], ["agent_cycles", "cost_output_tokens", "INTEGER"],
    ["agent_cycles", "cost_cached_tokens", "INTEGER"], ["agent_cycles", "cost_cache_write_tokens", "INTEGER"],
    ["agent_cycles", "cost_model_id", "TEXT"],
    ["integrations", "discovered_resources_json", "TEXT"], ["integrations", "discovered_at", "INTEGER"],
    ["agents", "integration_id", "TEXT REFERENCES integrations(id) ON DELETE SET NULL"],
    ["agents", "feedback_instructions_prompt_id", "TEXT REFERENCES prompts(id) ON DELETE SET NULL"],
    ["projects", "skill_sources_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["projects", "gerrit_topic_override", "TEXT"],
    ["projects", "use_full_ticket_url_in_commits", "INTEGER NOT NULL DEFAULT 0"],
    ["projects", "post_review_link_to_ticket", "INTEGER NOT NULL DEFAULT 0"],
    ["projects", "react_to_ci_failures", "INTEGER NOT NULL DEFAULT 0"],
    ["project_push_targets", "reviewer_emails", "TEXT NOT NULL DEFAULT '[]'"],
    ["prompts", "prompt_type", "TEXT NOT NULL DEFAULT 'instructions'"],
    ["app_settings", "agent_timeout_ms", "INTEGER"],
  ];
  for (const [table, column, definition] of additions) ensureColumn(raw, table, column, definition);
  dropColumnIfExists(raw, "projects", "skill_discovery_enabled");
  dropColumnIfExists(raw, "projects", "local_skills_path");
}

function ensureColumn(raw: Database.Database, table: string, column: string, definition: string): void {
  if (tableColumns(raw, table).includes(column)) return;
  raw.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${definition}`);
}

function dropColumnIfExists(raw: Database.Database, table: string, column: string): void {
  if (!tableColumns(raw, table).includes(column)) return;
  raw.exec(`ALTER TABLE ${quoteIdentifier(table)} DROP COLUMN ${quoteIdentifier(column)}`);
}

function migrateReferencedPromptRoles(raw: Database.Database): void {
  interface AgentPromptReferences {
    system_prompt_id: string | null;
    instructions_prompt_id: string | null;
    feedback_instructions_prompt_id: string | null;
  }
  interface ProjectPromptOverrides { id: string; agent_override_json: string | null }
  interface PromptRow { id: string; label: string; content: string; created_at: number; updated_at: number }

  const systemPromptIds = new Set<string>();
  const instructionsPromptIds = new Set<string>();
  const agentReferences = raw.prepare(`
    SELECT system_prompt_id, instructions_prompt_id, feedback_instructions_prompt_id FROM agents
  `).all() as AgentPromptReferences[];
  for (const references of agentReferences) {
    if (references.system_prompt_id !== null) systemPromptIds.add(references.system_prompt_id);
    if (references.instructions_prompt_id !== null) instructionsPromptIds.add(references.instructions_prompt_id);
    if (references.feedback_instructions_prompt_id !== null) instructionsPromptIds.add(references.feedback_instructions_prompt_id);
  }

  const projectOverrides = raw.prepare(`
    SELECT id, agent_override_json FROM projects WHERE agent_override_json IS NOT NULL
  `).all() as ProjectPromptOverrides[];
  const parsedOverrides = new Map<string, Record<string, unknown>>();
  for (const project of projectOverrides) {
    const override = parseConfigJson(project.agent_override_json ?? "");
    parsedOverrides.set(project.id, override);
    if (typeof override["systemPromptId"] === "string") systemPromptIds.add(override["systemPromptId"]);
    if (typeof override["instructionsPromptId"] === "string") instructionsPromptIds.add(override["instructionsPromptId"]);
    if (typeof override["feedbackInstructionsPromptId"] === "string") {
      instructionsPromptIds.add(override["feedbackInstructionsPromptId"]);
    }
  }

  for (const promptId of systemPromptIds) {
    if (!instructionsPromptIds.has(promptId)) continue;
    const prompt = raw.prepare(`
      SELECT id, label, content, created_at, updated_at FROM prompts WHERE id = ?
    `).get(promptId) as PromptRow | undefined;
    if (prompt === undefined) continue;
    let cloneId = `${promptId}__instructions`;
    let suffix = 2;
    while (raw.prepare("SELECT 1 FROM prompts WHERE id = ?").get(cloneId) !== undefined) {
      cloneId = `${promptId}__instructions_${suffix}`;
      suffix += 1;
    }
    raw.prepare(`
      INSERT INTO prompts (id, label, content, prompt_type, created_at, updated_at)
      VALUES (?, ?, ?, 'instructions', ?, ?)
    `).run(cloneId, `${prompt.label} (Instructions)`, prompt.content, prompt.created_at, prompt.updated_at);
    raw.prepare("UPDATE agents SET instructions_prompt_id = ? WHERE instructions_prompt_id = ?").run(cloneId, promptId);
    raw.prepare("UPDATE agents SET feedback_instructions_prompt_id = ? WHERE feedback_instructions_prompt_id = ?").run(cloneId, promptId);
    for (const [projectId, override] of parsedOverrides) {
      let changed = false;
      for (const key of ["instructionsPromptId", "feedbackInstructionsPromptId"] as const) {
        if (override[key] === promptId) { override[key] = cloneId; changed = true; }
      }
      if (changed) raw.prepare("UPDATE projects SET agent_override_json = ? WHERE id = ?").run(JSON.stringify(override), projectId);
    }
    instructionsPromptIds.delete(promptId);
    instructionsPromptIds.add(cloneId);
  }

  const updatePromptType = raw.prepare("UPDATE prompts SET prompt_type = ? WHERE id = ?");
  for (const promptId of instructionsPromptIds) updatePromptType.run("instructions", promptId);
  for (const promptId of systemPromptIds) updatePromptType.run("system", promptId);
}

function parseConfigJson(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
