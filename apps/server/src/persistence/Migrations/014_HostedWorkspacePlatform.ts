import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS hosted_projects (
      project_id TEXT PRIMARY KEY,
      owner_clerk_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      storage_root TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      git_remote_url TEXT,
      default_branch TEXT,
      current_branch TEXT,
      default_model TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hosted_projects_owner_slug
    ON hosted_projects(owner_clerk_user_id, slug)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_hosted_projects_owner_updated_at
    ON hosted_projects(owner_clerk_user_id, updated_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      owner_clerk_user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      provider TEXT,
      status TEXT NOT NULL,
      title TEXT,
      command TEXT,
      cwd TEXT NOT NULL,
      thread_id TEXT,
      input_json TEXT,
      result_json TEXT,
      result_summary TEXT,
      exit_code INTEGER,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_jobs_project_created_at
    ON jobs(project_id, created_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_jobs_owner_status
    ON jobs(owner_clerk_user_id, status, updated_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS job_events (
      event_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT,
      chunk TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(job_id, seq)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_job_events_job_seq
    ON job_events(job_id, seq ASC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_accounts (
      owner_clerk_user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      home_path TEXT NOT NULL,
      message TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (owner_clerk_user_id, provider)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS users_cache (
      clerk_user_id TEXT PRIMARY KEY,
      email TEXT,
      display_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
