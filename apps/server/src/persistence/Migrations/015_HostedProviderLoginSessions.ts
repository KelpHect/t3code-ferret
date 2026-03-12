import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_login_sessions (
      session_id TEXT PRIMARY KEY,
      owner_clerk_user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      home_path TEXT NOT NULL,
      verification_uri TEXT,
      user_code TEXT,
      expires_at TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_login_sessions_owner_provider_status
    ON provider_login_sessions(owner_clerk_user_id, provider, status, updated_at DESC)
  `;
});
