import BetterSqlite3 from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
export function initDatabase(dbPath) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    return new BetterSqlite3(dbPath);
}
//# sourceMappingURL=schema.js.map