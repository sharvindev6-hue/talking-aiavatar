import { Pool } from "@neondatabase/serverless";

const hasConnection = Boolean(process.env.DATABASE_URL);

export const pool = hasConnection
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

export const dbConfigured = hasConnection;

/**
 * Run a parameterized query. Throws a 503-style error when the database
 * has not been configured (DATABASE_URL missing).
 */
export async function query(text, params) {
  if (!pool) {
    const err = new Error(
      "Database not configured. Set DATABASE_URL in .env (Neon Postgres)."
    );
    err.status = 503;
    throw err;
  }
  return pool.query(text, params);
}

/**
 * Create tables if they do not exist. Called on server boot when a
 * DATABASE_URL is present, and by scripts/init-db.js for one-off runs.
 */
export async function initSchema() {
  if (!pool) return false;

  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'New chat',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      raw TEXT,
      emotion TEXT,
      gesture TEXT,
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // Keep existing tables up to date after schema changes.
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb`,
    // Hermes-style long-term memory: durable facts about the user.
    `CREATE TABLE IF NOT EXISTS memory_facts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fact TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other', -- preference | personal | project | habit | other
      confidence INTEGER NOT NULL DEFAULT 1,  -- 1 = stated explicitly, 0 = inferred
      source_session_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_memory_facts_user ON memory_facts(user_id)`,
    // LLM-written recap of each chat session (persistent memory across sessions).
    `CREATE TABLE IF NOT EXISTS session_summaries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE REFERENCES chat_sessions(id) ON DELETE CASCADE,
      summary TEXT NOT NULL,
      key_points JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }
  return true;
}
