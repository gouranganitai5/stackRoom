/* ============================================================
   db-abstraction.js — Stackroom Database Architecture Upgrade
   ------------------------------------------------------------
   The "storage abstraction" layer called for in Part 32 of the
   spec. It does NOT reimplement persistence — it delegates to
   whichever backend is currently authoritative:

     - TODAY: the existing Dexie/IndexedDB functions already in
       index.html (loadAll/persistData/persistSettings/etc.),
       injected once via init() so this file has zero direct
       Dexie dependency of its own.
     - AFTER a verified migration (migration.js sets state to
       VERIFIED/COMPLETED — see MIGRATION STATES below): SQLite
       via sqlite-service.js. Until sqlite-service.js reports a
       real engine is installed, this can never happen, so nothing
       here silently "upgrades" to SQLite without the real thing
       being present and a migration actually succeeding.

   This keeps the existing UI/business logic boundary the spec
   asks to preserve (Part 2): nothing in the existing CRUD/render
   code has to change, and everything new (Database Management
   panel, migration.js, backup-service.js) talks to THIS file
   instead of reaching into Dexie or SQLite directly.
   ============================================================ */
(function (global) {
  'use strict';

  const MIGRATION_STATES = Object.freeze({
    NOT_STARTED: 'NOT_STARTED',
    IN_PROGRESS: 'IN_PROGRESS',
    DATA_IMPORTED: 'DATA_IMPORTED',
    VERIFYING: 'VERIFYING',
    VERIFIED: 'VERIFIED',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED'
  });
  const MIGRATION_STATE_KEY = 'sqliteMigrationState';

  let refs = null; // injected by index.html — see init() below

  function init(injected) {
    // injected = {
    //   metaStore: { get(key), put(record), del(key) }  // wraps libraryDB.meta
    //   loadAll, persistData, persistSettings,
    //   getBookByBarcode, getTransactionsByStudent, writeAuditLog,
    //   getIndexedDbSnapshot()  -> { books, transactions, students, settings, auditLog }
    // }
    refs = injected;
  }

  function requireInit() {
    if (!refs) throw new Error('db-abstraction.js used before init() was called from the main app script.');
    return refs;
  }

  async function getMigrationState() {
    const r = requireInit();
    const rec = await r.metaStore.get(MIGRATION_STATE_KEY);
    return rec ? rec.value : MIGRATION_STATES.NOT_STARTED;
  }

  async function setMigrationState(state, detail) {
    const r = requireInit();
    if (!MIGRATION_STATES[state]) throw new Error('Unknown migration state: ' + state);
    await r.metaStore.put({ key: MIGRATION_STATE_KEY, value: state, detail: detail || null, updatedAt: new Date().toISOString() });
  }

  async function isSqliteAuthoritative() {
    const state = await getMigrationState();
    return (state === MIGRATION_STATES.VERIFIED || state === MIGRATION_STATES.COMPLETED) && global.StackroomSQLite.engineAvailable();
  }

  /** Part 36 status block for the Database Management UI. Never returns
   *  raw key material — only shape/status information. */
  async function databaseStatus() {
    const r = requireInit();
    const migrationState = await getMigrationState();
    const sqliteStatus = global.StackroomSQLite.status();
    const authoritative = await isSqliteAuthoritative();
    return {
      backend: authoritative ? 'SQLite (OPFS, encrypted)' : 'IndexedDB (Dexie, per-row AES-256-GCM)',
      migrationState,
      sqlite: sqliteStatus,
      dekWrapped: await global.StackroomKeyManager.hasWrappedDek(r.metaStore)
    };
  }

  // ---- Delegating CRUD surface -------------------------------------
  // Today these simply forward to the existing app functions so
  // existing call sites are unaffected. Once SQLite is authoritative
  // these would route to StackroomSQLite equivalents instead — left as
  // TODO hooks rather than guessed at, since the real SQL shape depends
  // on the vendored engine's actual API (see sqlite-service.js).
  async function loadAll() { return requireInit().loadAll(); }
  async function persistData(opts) { return requireInit().persistData(opts); }
  async function persistSettings() { return requireInit().persistSettings(); }
  async function getBookByBarcode(barcode) { return requireInit().getBookByBarcode(barcode); }
  async function getTransactionsByStudent(studentId) { return requireInit().getTransactionsByStudent(studentId); }
  async function writeAuditLog(action, entity, entityId, detail) { return requireInit().writeAuditLog(action, entity, entityId, detail); }

  global.StackroomDB = {
    MIGRATION_STATES,
    init,
    getMigrationState,
    setMigrationState,
    isSqliteAuthoritative,
    databaseStatus,
    loadAll,
    persistData,
    persistSettings,
    getBookByBarcode,
    getTransactionsByStudent,
    writeAuditLog
  };
})(window);
