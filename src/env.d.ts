// The Access client credentials are optional secrets (without them only agent API keys work), so
// `wrangler types` does not list them; this declares them as possibly absent.
declare namespace Cloudflare {
  interface Env {
    ACCESS_CLIENT_ID?: string;
    ACCESS_CLIENT_SECRET?: string;
  }
}

interface Env {
  /** Optional repository/path/tracker binding for the dashboard's generated state page. */
  STATE_PAGE?: string;
  PORTFOLIO_ARCHIVE?: {source: 'dolt'; label: string; points: import('./dashboard/data').Snapshot[]};
  PORTFOLIO_TITLE?: string;
  /** Optional JSON overriding the health alert thresholds, e.g. {"error_rate":0.02}; see docs/operations.md. */
  HEALTH_THRESHOLDS?: string;
  PORTFOLIO_REPOSITORIES?: string;
  /** Optional JSON {groups?, phases?} naming catalog groups and roadmap phases; see docs/dashboard.md. */
  PORTFOLIO_LABELS?: string;
  /** Optional private R2 bucket for the scheduled daily logical backups; absent: no scheduled backup. */
  BACKUP_BUCKET?: R2Bucket;
  /** Optional JSON {hour, retention_days} for the scheduled backup; see docs/operations.md. */
  BACKUP_POLICY?: string;
  /** Immutable deployment identity on the internal Worker; its version tag is the delivered source SHA. */
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
  /** GitHub App reader private key: a secret or a Secrets Store binding. Optional: roadmaps fail closed without it. */
  GITHUB_READ_APP_KEY?: string | {get(): Promise<string>};
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
}
