import BetterSqlite3 from 'better-sqlite3';
type DbType = ReturnType<typeof BetterSqlite3>;
export declare function initDatabase(dbPath: string): DbType;
export type AppDatabase = ReturnType<typeof initDatabase>;
export {};
//# sourceMappingURL=schema.d.ts.map