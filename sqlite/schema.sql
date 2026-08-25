-- ============================================================
-- Stackroom — target SQLite schema (Parts 25-30)
-- ------------------------------------------------------------
-- Every column here was found by reading the ACTUAL object shapes
-- constructed in index.html (book-form save handler, issue/return
-- workflow, student-add handler, writeAuditLog, SETTINGS default),
-- not guessed from the Dexie index list — Dexie only indexes a
-- handful of fields (see STACKROOM_DB_SCHEMA_V3 in index.html);
-- the rest of each record's shape lives in plain JS object literals.
--
-- DELIBERATELY LOOSE, PER PART 25's OWN WARNING:
-- - `books.barcode` is NOT declared UNIQUE. The existing app only
--   enforces uniqueness in the book-edit FORM (see bookModalSave's
--   existingByBarcode check in index.html) — not as a Dexie index,
--   not anywhere data can be written outside that one form (bulk
--   import, sample barcode, etc. do not re-check it the same way).
--   Adding a UNIQUE constraint here could reject real legacy rows
--   during migration that the source database never actually
--   guaranteed were unique. If a future admin confirms real data is
--   clean, this can be tightened in a later schema version.
-- - No CHECK constraints on `status` enums (book/transaction status
--   strings) — the source app treats these as free-form strings in
--   several places (see syncBookAutoStatus, Master Reset's status
--   resets); a CHECK could reject a legacy value the app itself
--   would have accepted.
-- - Money is stored in integer paise (1/100 of the display currency
--   unit), exactly as the source app already does
--   (`fineAmountPaisePerDay`, `fineAmountPaise`) — no unit change.
--
-- This file is pure DDL and can be authored/reviewed without a
-- SQLite engine present. It becomes executable the moment
-- js/sqlite-service.js has a real `exec()` — see that file's header
-- for what's still missing.
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---- schema/app version bookkeeping (Part 25, "versioned schema") ----
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT,          -- JSON-encoded for structured values (mirrors Dexie's meta store, which already stores mixed shapes per key)
  updated_at TEXT       -- ISO-8601, set by the application on every write
);
-- Expected rows (not enforced by schema — same free-form key/value
-- shape the existing Dexie `meta` store already uses):
--   schemaVersion, appVersion, sqliteMigrationState,
--   sqliteDekWrapPin, sqliteDekWrapRecovery, authVerifier,
--   recoveryVerifier, authFailCount, authLockUntil,
--   recoveryFailCount, recoveryLockUntil, migrationVersion

-- ---- books ----
CREATE TABLE IF NOT EXISTS books (
  id       TEXT PRIMARY KEY,     -- Dexie: &id (unique) — carried over as-is, never regenerated during migration (Part 24)
  barcode  TEXT NOT NULL,        -- intentionally NOT UNIQUE — see file header
  title    TEXT NOT NULL,
  author   TEXT NOT NULL,
  class    TEXT,                 -- free text (e.g. grade/level), not a foreign key — matches source app
  subject  TEXT,
  shelf    TEXT,
  status   TEXT NOT NULL DEFAULT 'Available',  -- 'Available' | 'Issued' | 'Lost' | 'Damaged' seen in source; not CHECK-constrained, see header
  copies   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_books_barcode ON books(barcode);

-- ---- students ----
CREATE TABLE IF NOT EXISTS students (
  student_id TEXT PRIMARY KEY,   -- Dexie: &studentId
  name       TEXT NOT NULL,
  class      TEXT,
  section    TEXT,
  allow_multiple_books INTEGER NOT NULL DEFAULT 0  -- boolean as 0/1; source default is `false`/absent-means-false (see index.html studentAllowsMultipleBooks)
);

-- ---- transactions ----
CREATE TABLE IF NOT EXISTS transactions (
  id                    TEXT PRIMARY KEY,   -- Dexie: &id
  book_barcode          TEXT NOT NULL,
  book_id               TEXT,               -- denormalized copy of books.id at issue time, exactly as the source app stores it (not re-derived via JOIN, since a book's id/barcode/title could theoretically change after issue in the source app and the transaction snapshot must not silently change with it)
  book_title            TEXT,               -- denormalized snapshot, same reasoning
  student_id            TEXT NOT NULL,      -- Dexie index: studentId (non-unique)
  student_name          TEXT,               -- denormalized snapshot
  student_class          TEXT,               -- denormalized snapshot
  issue_date            TEXT NOT NULL,      -- ISO date string, as stored by source
  expected_return_date  TEXT,
  return_date           TEXT,               -- NULL while outstanding
  status                TEXT NOT NULL,      -- 'issued' | 'returned' seen in source; not CHECK-constrained, see header
  fine_days             INTEGER,            -- set at return time (getFineDays) — NULL until then
  fine_amount_paise     INTEGER,            -- set at return time (calculateCurrentFine) — integer paise, NULL until then
  fine_paid             INTEGER,            -- boolean 0/1, NULL until a fine exists
  fine_paid_at          TEXT,               -- ISO timestamp, NULL until marked paid
  was_early_return      INTEGER,            -- boolean 0/1, set once at return time (finalizeReturnFineFields) — NULL until returned
  returned_during_grace INTEGER             -- boolean 0/1, set once at return time — NULL until returned
);
CREATE INDEX IF NOT EXISTS idx_transactions_student_id ON transactions(student_id);

-- ---- settings ----
-- Source app keeps exactly one row (key='app-settings') containing the
-- whole SETTINGS object as JSON — mirrored here as a key/value table
-- (matching Dexie's `&key` settings store) rather than flattened into
-- columns, so a future admin-configurable setting added to the source
-- app's SETTINGS object doesn't require a schema migration to persist.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT   -- JSON-encoded SETTINGS object: {theme, schoolName, gracePeriodDays, fineAmountPaisePerDay}
);

-- ---- audit log ----
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- Dexie: ++id
  timestamp  TEXT NOT NULL,   -- ISO-8601, as written by writeAuditLog()
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);

-- ---- schema version marker ----
-- A dedicated row (not just "schema exists") so verifyDatabase() (Part
-- 32) can distinguish "empty but correctly-versioned SQLite DB" from
-- "SQLite DB from an incompatible future/older schema version" without
-- inspecting every table's column list on every open.
INSERT OR IGNORE INTO meta (key, value, updated_at)
  VALUES ('schemaVersion', '1', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
