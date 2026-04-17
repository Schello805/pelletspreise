import path from "node:path";

let dbInstance = null;
let dbInitTried = false;

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      createdAt TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_createdAt ON history(createdAt);

    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      dateKey TEXT NOT NULL,
      storedAt TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cache_dateKey ON cache(dateKey);
  `);
}

export async function getDb({ projectRoot }) {
  if (dbInitTried) return dbInstance;
  dbInitTried = true;

  try {
    const mod = await import("better-sqlite3");
    const Database = mod?.default || mod;
    const dbPath = path.join(projectRoot, "server", "data", "pelletpreise.db");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    ensureSchema(db);
    dbInstance = db;
  } catch {
    dbInstance = null;
  }

  return dbInstance;
}

