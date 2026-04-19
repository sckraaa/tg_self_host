import type BetterSqlite3 from 'better-sqlite3';
export interface RawCaptureRunInput {
    source: string;
    accountLabel?: string;
    sessionMainDcId?: number;
    sessionIsTest?: boolean;
    notes?: string;
}
export interface RawCaptureEntryInput {
    runId: number;
    method: string;
    scope?: string;
    peerKey?: string;
    requestJson: string;
    responseJson: string;
    responseClassName?: string;
    responseConstructorId?: number;
    capturedAt?: number;
}
export declare function initRawCaptureSchema(db: BetterSqlite3.Database): void;
export declare function createRawCaptureRun(db: BetterSqlite3.Database, input: RawCaptureRunInput): number;
export declare function insertRawCapture(db: BetterSqlite3.Database, input: RawCaptureEntryInput): void;
//# sourceMappingURL=rawCapture.d.ts.map