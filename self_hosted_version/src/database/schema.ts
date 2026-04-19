import BetterSqlite3 from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

type DbType = ReturnType<typeof BetterSqlite3>;

export function initDatabase(dbPath: string): DbType {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  return new BetterSqlite3(dbPath);
}

export type AppDatabase = ReturnType<typeof initDatabase>;
