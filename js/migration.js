/* ============================================================
   migration.js — Stackroom Database Architecture Upgrade
   ------------------------------------------------------------
   Implements the IndexedDB -> SQLite migration state machine
   (Part 23) and its verification step (Part 40). Designed to be
   safe to interrupt and retry at any point (Part 24, Part 41):

     NOT_STARTED -> IN_PROGRESS -> DATA_IMPORTED -> VERIFYING
                 -> VERIFIED -> COMPLETED
                 (-> FAILED at any point, always retry-safe)

   INVARIANTS (do not weaken these)
   - The IndexedDB database is only ever READ during migration,
     never deleted or mutated. runMigration() has no code path
     that writes to libraryDB's books/transactions/students/
     settings/auditLog tables.
   - SQLite is only marked VERIFIED/COMPLETED (and therefore only
     becomes authoritative — see db-abstraction.js) after an
     independent post-insert checksum comparison passes for every
     table. A record-count match alone is never sufficient.
   - Because sqlite-service.js currently has no vendored engine,
     runMigration() will reliably stop at IN_PROGRESS -> FAILED
     with a clear "engine missing" reason the first time it tries
     to actually open/create the SQLite database, and this is the
     CORRECT behavior — not a bug to work around by relaxing these
     invariants.
   ============================================================ */
(function (global) {
  'use strict';

  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** Deterministic fingerprint of a logical record: stable key order,
   *  so the same record always hashes the same way regardless of
   *  property insertion order. */
  function normalize(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(normalize);
    return Object.keys(obj).sort().reduce((acc, k) => { acc[k] = normalize(obj[k]); return acc; }, {});
  }

  async function fingerprintRecords(records) {
    // One checksum per record (by stable id) PLUS one aggregate checksum
    // over the sorted list, so verification can report exactly which
    // record(s) mismatched rather than only "something's different".
    const perRecord = {};
    for (const r of records) {
      const idKey = r.id || r.studentId || r.key || JSON.stringify(r);
      perRecord[idKey] = await sha256Hex(JSON.stringify(normalize(r)));
    }
    const aggregate = await sha256Hex(Object.keys(perRecord).sort().map((k) => k + ':' + perRecord[k]).join('|'));
    return { perRecord, aggregate, count: records.length };
  }

  async function compareFingerprints(source, dest) {
    if (source.count !== dest.count) {
      return { ok: false, reason: `count mismatch: source=${source.count} dest=${dest.count}` };
    }
    const mismatched = [];
    for (const id of Object.keys(source.perRecord)) {
      if (source.perRecord[id] !== dest.perRecord[id]) mismatched.push(id);
    }
    if (mismatched.length) return { ok: false, reason: `${mismatched.length} record(s) mismatched`, mismatched };
    return { ok: true };
  }

  /**
   * Run (or resume) the migration. Never throws for the "expected today"
   * case of a missing SQLite engine — instead resolves with a structured
   * result the Database Management UI can display, and leaves
   * migration state as FAILED (safe to retry once an engine is vendored).
   */
  async function runMigration(metaStore, snapshotProvider, pin, recoveryCode) {
    const DB = global.StackroomDB;
    const KM = global.StackroomKeyManager;
    const SQL = global.StackroomSQLite;

    const already = await DB.getMigrationState();
    if (already === DB.MIGRATION_STATES.VERIFIED || already === DB.MIGRATION_STATES.COMPLETED) {
      return { ok: true, alreadyMigrated: true, state: already };
    }

    await DB.setMigrationState(DB.MIGRATION_STATES.IN_PROGRESS, 'reading IndexedDB snapshot');

    let snapshot;
    try {
      snapshot = await snapshotProvider(); // { books, transactions, students, settings, auditLog }
    } catch (e) {
      await DB.setMigrationState(DB.MIGRATION_STATES.FAILED, 'could not read source IndexedDB data: ' + e.message);
      return { ok: false, reason: 'source-read-failed', error: e.message };
    }

    if (!SQL.engineAvailable()) {
      // Expected in this build. IndexedDB has not been touched.
      await DB.setMigrationState(DB.MIGRATION_STATES.FAILED, 'SQLITE_ENGINE_MISSING — see sqlite-service.js');
      return { ok: false, reason: 'SQLITE_ENGINE_MISSING', recordsRead: {
        books: snapshot.books.length, transactions: snapshot.transactions.length,
        students: snapshot.students.length, auditLog: snapshot.auditLog.length
      } };
    }

    try {
      // Part 21: brand-new random DEK for the SQLite DB, wrapped under the
      // SAME PIN and Recovery Code the admin is already authenticated with.
      const dekBytes = await KM.createAndWrapDek(metaStore, pin, recoveryCode);

      await DB.setMigrationState(DB.MIGRATION_STATES.IN_PROGRESS, 'creating encrypted SQLite database');
      await SQL.open('stackroom-library.sqlite', dekBytes);
      // Schema DDL lives in sqlite/schema.sql — statement-by-statement,
      // since exec() here runs one statement per call (no multi-statement
      // splitting implemented in sqlite-worker.js yet).
      const ddlStatements = (await (await fetch('sqlite/schema.sql')).text())
        .split(';').map((s) => s.trim()).filter((s) => s && !s.startsWith('--'));
      for (const stmt of ddlStatements) await SQL.exec(stmt + ';');

      await DB.setMigrationState(DB.MIGRATION_STATES.IN_PROGRESS, 'inserting records');
      const St = global.StackroomSQL.statements;
      const bookSteps = snapshot.books.map((b) => ({ sql: St.insertBook, params: {
        id: b.id, barcode: b.barcode, title: b.title, author: b.author, class: b.class,
        subject: b.subject, shelf: b.shelf, status: b.status, copies: b.copies
      } }));
      const studentSteps = snapshot.students.map((s) => ({ sql: St.upsertStudent, params: {
        studentId: s.studentId, name: s.name, class: s.class, section: s.section,
        allowMultipleBooks: s.allowMultipleBooks ? 1 : 0
      } }));
      const txSteps = snapshot.transactions.map((t) => ({ sql: St.insertTransaction, params: {
        id: t.id, bookBarcode: t.bookBarcode, bookId: t.bookId, bookTitle: t.bookTitle,
        studentId: t.studentId, studentName: t.studentName, studentClass: t.studentClass,
        issueDate: t.issueDate, expectedReturnDate: t.expectedReturnDate
      } }));
      // insertTransaction only covers the issue-time columns (see
      // sql-statements.js) — already-returned/fined loans need a follow-up
      // markTransactionReturned-shaped UPDATE per record, appended here so
      // historical fine/return data isn't silently dropped during migration.
      const txReturnSteps = snapshot.transactions
        .filter((t) => t.status === 'returned')
        .map((t) => ({ sql: St.markTransactionReturned, params: {
          id: t.id, returnDate: t.returnDate, fineDays: t.fineDays ?? null,
          fineAmountPaise: t.fineAmountPaise ?? null, finePaid: t.finePaid ? 1 : 0,
          wasEarlyReturn: t.wasEarlyReturn ? 1 : 0, returnedDuringGrace: t.returnedDuringGrace ? 1 : 0
        } }));
      const auditSteps = snapshot.auditLog.map((a) => ({ sql: St.insertAuditLog, params: {
        id: a.id, timestamp: a.timestamp, action: a.action, entity: a.entity, entityId: a.entityId, detail: a.detail
      } }));
      const settingsStep = [{ sql: St.putSettings, params: { valueJson: JSON.stringify(snapshot.settings) } }];
      await SQL.transaction([...bookSteps, ...studentSteps, ...txSteps, ...txReturnSteps, ...auditSteps, ...settingsStep]);

      await DB.setMigrationState(DB.MIGRATION_STATES.DATA_IMPORTED, 'verifying');
      await DB.setMigrationState(DB.MIGRATION_STATES.VERIFYING);

      const sourceFingerprints = {
        books: await fingerprintRecords(snapshot.books),
        transactions: await fingerprintRecords(snapshot.transactions),
        students: await fingerprintRecords(snapshot.students),
        auditLog: await fingerprintRecords(snapshot.auditLog)
      };

      // Read back what's actually in SQLite now and reshape each row from
      // the schema's snake_case columns to the SAME field names/shape the
      // source snapshot objects use — fingerprints must compare like-for-
      // like, or every migration would "fail" on naming alone regardless
      // of whether the data actually matches.
      const destBookRows = await SQL.exec(St.listBooks);
      const destStudentRows = await SQL.exec(St.listStudents);
      const destTxRows = await SQL.exec(`SELECT * FROM transactions`);
      const destAuditRows = await SQL.exec(`SELECT * FROM audit_log`);

      const destBooks = destBookRows.map((r) => ({
        id: r.id, barcode: r.barcode, title: r.title, author: r.author, class: r.class,
        subject: r.subject, shelf: r.shelf, status: r.status, copies: r.copies
      }));
      const destStudents = destStudentRows.map((r) => ({
        studentId: r.student_id, name: r.name, class: r.class, section: r.section,
        allowMultipleBooks: !!r.allow_multiple_books
      }));
      const destTransactions = destTxRows.map((r) => ({
        id: r.id, bookBarcode: r.book_barcode, bookId: r.book_id, bookTitle: r.book_title,
        studentId: r.student_id, studentName: r.student_name, studentClass: r.student_class,
        issueDate: r.issue_date, expectedReturnDate: r.expected_return_date, returnDate: r.return_date,
        status: r.status, fineDays: r.fine_days, fineAmountPaise: r.fine_amount_paise,
        finePaid: r.fine_paid === null ? null : !!r.fine_paid, finePaidAt: r.fine_paid_at,
        wasEarlyReturn: r.was_early_return === null ? null : !!r.was_early_return,
        returnedDuringGrace: r.returned_during_grace === null ? null : !!r.returned_during_grace
      }));
      const destAuditLog = destAuditRows.map((r) => ({
        id: r.id, timestamp: r.timestamp, action: r.action, entity: r.entity, entityId: r.entity_id, detail: r.detail
      }));

      const destFingerprints = {
        books: await fingerprintRecords(destBooks),
        transactions: await fingerprintRecords(destTransactions),
        students: await fingerprintRecords(destStudents),
        auditLog: await fingerprintRecords(destAuditLog)
      };

      const destSettingsRows = await SQL.exec(St.getSettings);
      const destSettings = destSettingsRows[0] ? JSON.parse(destSettingsRows[0].value) : null;
      const settingsSourceHash = await sha256Hex(JSON.stringify(normalize(snapshot.settings)));
      const settingsDestHash = await sha256Hex(JSON.stringify(normalize(destSettings)));
      const settingsOk = settingsSourceHash === settingsDestHash;

      const comparisons = {
        books: await compareFingerprints(sourceFingerprints.books, destFingerprints.books),
        transactions: await compareFingerprints(sourceFingerprints.transactions, destFingerprints.transactions),
        students: await compareFingerprints(sourceFingerprints.students, destFingerprints.students),
        auditLog: await compareFingerprints(sourceFingerprints.auditLog, destFingerprints.auditLog),
        settings: settingsOk ? { ok: true } : { ok: false, reason: 'settings JSON does not match' }
      };
      const failedTables = Object.keys(comparisons).filter((k) => !comparisons[k].ok);

      if (failedTables.length) {
        // Fail closed: SQLite is NOT marked authoritative, IndexedDB
        // stays the source of truth, and the mismatch detail is
        // returned so the Database Management panel can show exactly
        // which table(s) and record(s) didn't verify (Part 40/42).
        await DB.setMigrationState(DB.MIGRATION_STATES.FAILED, 'verification mismatch in: ' + failedTables.join(', '));
        return { ok: false, reason: 'verification-mismatch', comparisons };
      }

      await DB.setMigrationState(DB.MIGRATION_STATES.VERIFIED, 'checksums matched for all tables');
      await DB.setMigrationState(DB.MIGRATION_STATES.COMPLETED);
      return { ok: true, comparisons };
    } catch (e) {
      await DB.setMigrationState(DB.MIGRATION_STATES.FAILED, e.message);
      return { ok: false, reason: 'exception', error: e.message };
    }
  }

  global.StackroomMigration = { runMigration, fingerprintRecords, compareFingerprints };
})(window);
