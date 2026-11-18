import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code TEXT NOT NULL UNIQUE,
      target_url TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      disabled INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      clicked_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      device TEXT NOT NULL,
      browser TEXT NOT NULL,
      country TEXT,
      visitor TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_clicks_link_time ON clicks(link_id, clicked_at);
    CREATE INDEX IF NOT EXISTS idx_clicks_time ON clicks(clicked_at);
    CREATE INDEX IF NOT EXISTS idx_links_user ON links(user_id);
  `);
  return db;
}
