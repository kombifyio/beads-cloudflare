import { all } from "./model";

// SQLite schema of one team (one Durable Object). Every table is keyed by tracker, the Beads project.

export const SCHEMA_VERSION = 3;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS issues (
  tracker TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  design TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  priority INTEGER NOT NULL,
  issue_type TEXT NOT NULL,
  assignee TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  estimated_minutes INTEGER,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  started_at TEXT,
  closed_at TEXT,
  close_reason TEXT NOT NULL DEFAULT '',
  closed_by_session TEXT NOT NULL DEFAULT '',
  external_ref TEXT,
  due_at TEXT,
  defer_until TEXT,
  sender TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  ephemeral INTEGER NOT NULL DEFAULT 0,
  no_history INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  -- Extension state: optimistic-concurrency version, lease and fencing number of the current claim.
  version INTEGER NOT NULL DEFAULT 1,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  -- The verified principal holding the live lease. Distinct from assignee, which is the
  -- name work is allocated to and which the caller chooses.
  claimed_by TEXT NOT NULL DEFAULT '',
  fencing INTEGER NOT NULL DEFAULT 0,
  -- Core Issue members this server stores but never queries (spec_id, is_template, wisp_type, ...), kept
  -- as one JSON object and emitted verbatim. Filled by the import route.
  extra TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (tracker, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS issues_by_status ON issues (tracker, status, priority, created_at);
CREATE INDEX IF NOT EXISTS issues_by_created ON issues (tracker, created_at, id);

CREATE TABLE IF NOT EXISTS labels (
  tracker TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (tracker, issue_id, label)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS labels_by_label ON labels (tracker, label);

CREATE TABLE IF NOT EXISTS dependencies (
  tracker TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  type TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tracker, issue_id, depends_on_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS dependencies_by_target ON dependencies (tracker, depends_on_id, type);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  tracker TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_by_issue ON comments (tracker, issue_id, created_at);

-- The durable workspace settings plane bd config reads and writes. Keys are
-- case-sensitive: "MyKey" and "mykey" are two distinct settings.
CREATE TABLE IF NOT EXISTS config (
  tracker TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (tracker, key)
) WITHOUT ROWID;

-- Normalized projection of the status.custom setting. Kept as its own table
-- because the vocabulary is queried by name and category, not as one string.
CREATE TABLE IF NOT EXISTS custom_statuses (
  tracker TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  PRIMARY KEY (tracker, name)
) WITHOUT ROWID;

-- Normalized projection of the types.custom setting.
CREATE TABLE IF NOT EXISTS custom_types (
  tracker TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (tracker, name)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS memories (
  tracker TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (tracker, key)
) WITHOUT ROWID;

-- Append-only; seq is team-wide and strictly increasing, readers filter by tracker.
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tracker TEXT NOT NULL,
  ts TEXT NOT NULL,
  op TEXT NOT NULL,
  kind TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  client_actor TEXT,
  issue TEXT,
  dep TEXT,
  comment TEXT
);
CREATE INDEX IF NOT EXISTS events_by_tracker ON events (tracker, seq);

-- Agent API keys: only the SHA-256 of the secret is stored.
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  trackers TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT
) WITHOUT ROWID;

-- One receipt per (principal, Idempotency-Key): the request hash and the stored response.
CREATE TABLE IF NOT EXISTS receipts (
  principal TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  etag TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (principal, key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS receipts_by_age ON receipts (created_at);
`;

/**
 * Columns added after the first released schema, applied to objects that already exist.
 *
 * SCHEMA is CREATE TABLE IF NOT EXISTS throughout, which creates a missing table
 * but never adds a column to one that is already there. A Durable Object that
 * was created before a column existed keeps the old shape forever, and the first
 * write that mentions the new column fails as an opaque SQL error the caller sees
 * as a 500.
 *
 * That is not hypothetical: adding heartbeat_at and claimed_by shipped a Worker
 * whose claim path returned 500 in production while every local test passed,
 * because a fresh local object was built from the new SCHEMA and the deployed
 * one was not.
 *
 * SQLite has no ADD COLUMN IF NOT EXISTS, so each step probes the table first.
 * The whole list runs inside one transaction on every construction, which costs
 * one schema read per object activation.
 */
export const COLUMN_MIGRATIONS: readonly { table: string; column: string; definition: string }[] = [
  { table: "issues", column: "heartbeat_at", definition: "TEXT" },
  { table: "issues", column: "claimed_by", definition: "TEXT NOT NULL DEFAULT ''" },
  { table: "issues", column: "extra", definition: "TEXT NOT NULL DEFAULT '{}'" },
];

const columnsOf = (sql: SqlStorage, table: string): Set<string> => {
  const rows = all<{ name: string }>(sql, `PRAGMA table_info(${table})`);
  return new Set(rows.map((r) => r.name));
};

/** Brings an existing object up to the current column set. Idempotent. */
export function migrateColumns(sql: SqlStorage): void {
  for (const { table, column, definition } of COLUMN_MIGRATIONS) {
    if (columnsOf(sql, table).has(column)) continue;
    sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * Rows written by the first releases can hold values the current reads and filters do not expect: a flag
 * that is NULL or not 0 and 1 hides the row from every default list, count, stats and export (the tier filter
 * compares it with 0), and an empty or NULL JSON column breaks the json functions. This sets such values to
 * what a freshly created row holds. It is idempotent and recorded in `meta`, so an object that has done it
 * pays one primary-key read per start.
 */
export const ROWS_NORMALIZED = "rows_normalized_v1";

const FLAG_COLUMNS = ["ephemeral", "no_history", "pinned"] as const;
const JSON_COLUMNS = ["metadata", "extra"] as const;
const TEXT_COLUMNS = [
  "description", "design", "acceptance_criteria", "notes", "assignee", "owner", "created_by", "close_reason",
  "closed_by_session", "sender", "claimed_by",
] as const;

export function normalizeRows(sql: SqlStorage): void {
  if (all(sql, "SELECT 1 FROM meta WHERE key = ?", ROWS_NORMALIZED).length > 0) return;
  for (const column of FLAG_COLUMNS) sql.exec(`UPDATE issues SET ${column} = 0 WHERE ${column} IS NULL OR ${column} NOT IN (0, 1)`);
  for (const column of JSON_COLUMNS) sql.exec(`UPDATE issues SET ${column} = '{}' WHERE ${column} IS NULL OR TRIM(${column}) = ''`);
  for (const column of TEXT_COLUMNS) sql.exec(`UPDATE issues SET ${column} = '' WHERE ${column} IS NULL`);
  sql.exec("UPDATE issues SET version = 1 WHERE version IS NULL");
  sql.exec("UPDATE issues SET fencing = 0 WHERE fencing IS NULL");
  sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES (?, '1')", ROWS_NORMALIZED);
}
