-- Accounts: people, log-in emails and sessions.
-- Log-in tokens, codes and session ids are stored only as SHA-256 hashes.
-- Times are ISO 8601 text in UTC, for example 2026-10-09T18:00:00.000Z, so they sort in time order.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE login_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX login_codes_email_created_at ON login_codes (email, created_at);
CREATE INDEX login_codes_token_hash ON login_codes (token_hash);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX sessions_user_id ON sessions (user_id);
