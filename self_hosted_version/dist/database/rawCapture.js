export function initRawCaptureSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_capture_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      account_label TEXT,
      session_main_dc_id INTEGER,
      session_is_test INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS telegram_raw_captures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      method TEXT NOT NULL,
      scope TEXT,
      peer_key TEXT,
      request_json TEXT NOT NULL,
      response_json TEXT NOT NULL,
      response_class_name TEXT,
      response_constructor_id INTEGER,
      captured_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES telegram_capture_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_telegram_raw_captures_run_id
      ON telegram_raw_captures(run_id);

    CREATE INDEX IF NOT EXISTS idx_telegram_raw_captures_method
      ON telegram_raw_captures(method);
  `);
}
export function createRawCaptureRun(db, input) {
    const result = db.prepare(`
    INSERT INTO telegram_capture_runs (
      source,
      account_label,
      session_main_dc_id,
      session_is_test,
      notes,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(input.source, input.accountLabel || null, input.sessionMainDcId || null, input.sessionIsTest ? 1 : 0, input.notes || null, Math.floor(Date.now() / 1000));
    return Number(result.lastInsertRowid);
}
export function insertRawCapture(db, input) {
    db.prepare(`
    INSERT INTO telegram_raw_captures (
      run_id,
      method,
      scope,
      peer_key,
      request_json,
      response_json,
      response_class_name,
      response_constructor_id,
      captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.runId, input.method, input.scope || null, input.peerKey || null, input.requestJson, input.responseJson, input.responseClassName || null, input.responseConstructorId || null, input.capturedAt || Math.floor(Date.now() / 1000));
}
//# sourceMappingURL=rawCapture.js.map