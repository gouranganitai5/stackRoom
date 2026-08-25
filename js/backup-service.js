/* ============================================================
   backup-service.js — Stackroom Database Architecture Upgrade
   ------------------------------------------------------------
   Encrypted whole-database export/import (Parts 15-17), additional
   to — and never touching — the existing encrypted JSON backup in
   index.html (Part 34).

   FORMAT
   stackroom-library-YYYY-MM-DD.db.enc is a JSON envelope containing
   the still-encrypted SQLite file bytes PLUS the PIN-wrapped and
   Recovery-wrapped DEK records, so a second device can unlock it
   with the same PIN or Recovery Code without ever handling a raw
   key:
     { format: 'stackroom-db-enc', version: 1, cipher, exportedAt,
       wrappedDekPin: <record from key-manager.js>,
       wrappedDekRecovery: <record from key-manager.js>,
       payloadB64: <base64 of the SQLite engine's own encrypted
                    file bytes, untouched — no second encryption
                    layer added here> }
   The wrapped-DEK records are themselves AES-256-GCM-encrypted
   (crypto-service.js) — including them in the envelope is exactly
   as safe as their PIN/Recovery-wrapped copies already sitting in
   the source device's `meta` table.

   IMPORT SAFETY (Part 16/17) — CONFIRMED REAL METHODS USED
   Verified by reading the actual vendored sqlite3.mjs, not assumed:
   `exportFile(name)`, `importDb(name, bytes)`, and `deletePath(path)`
   are real methods on the OpfsSAHPool class. Import therefore:
     1. imports the incoming bytes under a STAGING filename (never
        the live one)
     2. opens the staging file with the unwrapped DEK and runs an
        integrity/schema check
     3. only on success: deletePath(liveName), then importDb(liveName,
        the same bytes already in memory) to install it, then
        deletePath(stagingName)
   If step 2 fails, the staging file is deleted and the live database
   is never touched — matching Part 17's "reject and leave current
   database untouched" requirement.
   ============================================================ */
(function (global) {
  'use strict';

  const LIVE_FILE = 'stackroom-library.sqlite';
  const STAGING_FILE = 'stackroom-library.import-staging.sqlite';

  function notReadyError(reason) {
    const err = new Error('Encrypted database export/import is not available yet: ' + reason);
    err.code = 'DB_ENC_NOT_READY';
    return err;
  }

  async function assertReady() {
    const DB = global.StackroomDB;
    const SQL = global.StackroomSQLite;
    if (!SQL.engineAvailable()) throw notReadyError('the encrypted SQLite engine is not activated (see js/sqlite-service.js).');
    if (!(await DB.isSqliteAuthoritative())) throw notReadyError('migration to SQLite has not completed and been verified yet — the IndexedDB database is still authoritative and is unaffected.');
  }

  async function exportEncryptedDatabase(metaStore) {
    await assertReady();
    const SQL = global.StackroomSQLite;
    const bytes = await SQL.exportEncryptedBytes(LIVE_FILE); // real: OpfsSAHPool.exportFile()
    const status = SQL.status();
    const [pinRec, recoveryRec] = await Promise.all([
      metaStore.get('sqliteDekWrapPin'),
      metaStore.get('sqliteDekWrapRecovery')
    ]);
    const envelope = {
      format: 'stackroom-db-enc',
      version: 1,
      cipher: status.cipher,
      exportedAt: new Date().toISOString(),
      wrappedDekPin: pinRec || null,
      wrappedDekRecovery: recoveryRec || null,
      payloadB64: global.StackroomCrypto.bufToBase64(bytes.buffer || bytes)
    };
    const json = JSON.stringify(envelope);
    const filename = `stackroom-library-${new Date().toISOString().slice(0, 10)}.db.enc`;
    return { filename, blob: new Blob([json], { type: 'application/octet-stream' }) };
  }

  async function importEncryptedDatabase(fileBytesOrText, secret, secretKind /* 'pin' | 'recovery' */) {
    const SQL = global.StackroomSQLite;
    if (!SQL.engineAvailable()) throw notReadyError('the encrypted SQLite engine is not activated — the current database is untouched.');

    let envelope;
    try {
      const text = typeof fileBytesOrText === 'string' ? fileBytesOrText : new TextDecoder().decode(fileBytesOrText);
      envelope = JSON.parse(text);
    } catch (e) {
      const err = new Error('Selected file is not a valid Stackroom .db.enc export.');
      err.code = 'DB_ENC_INVALID_FORMAT';
      throw err;
    }
    if (envelope.format !== 'stackroom-db-enc' || typeof envelope.payloadB64 !== 'string') {
      const err = new Error('File does not match the expected .db.enc structure.');
      err.code = 'DB_ENC_INVALID_FORMAT';
      throw err;
    }

    const wrappedRecord = secretKind === 'recovery' ? envelope.wrappedDekRecovery : envelope.wrappedDekPin;
    if (!wrappedRecord) {
      const err = new Error(`This backup has no ${secretKind === 'recovery' ? 'Recovery Code' : 'PIN'}-wrapped key — try the other unlock method.`);
      err.code = 'DB_ENC_NO_WRAPPED_KEY';
      throw err;
    }

    let dekBytes;
    try {
      dekBytes = await global.StackroomCrypto.unwrapDek(wrappedRecord, secret);
    } catch (e) {
      const err = new Error('Could not unlock this backup with the provided ' + (secretKind === 'recovery' ? 'Recovery Code' : 'PIN') + '.');
      err.code = 'DB_ENC_WRONG_SECRET';
      throw err;
    }

    const payloadBytes = new Uint8Array(global.StackroomCrypto.base64ToBuf(envelope.payloadB64));

    // Stage, then validate, then swap (Part 16/17) — see file header.
    await SQL.importEncryptedBytes(payloadBytes, STAGING_FILE); // real: OpfsSAHPool.importDb()
    try {
      await SQL.open(STAGING_FILE, dekBytes);
      const schemaCheck = await SQL.exec(`SELECT value FROM meta WHERE key='schemaVersion'`);
      if (!schemaCheck.length) throw new Error('Imported database has no recognizable Stackroom schema.');
      await SQL.close();
    } catch (e) {
      // Validation failed — remove the staging file, live database untouched.
      try { await SQL.deletePath(STAGING_FILE); } catch (e2) {}
      const err = new Error('Imported file failed validation and was not installed: ' + e.message);
      err.code = 'DB_ENC_VALIDATION_FAILED';
      throw err;
    }

    // Validated — install as the live database.
    await SQL.deletePath(LIVE_FILE);
    await SQL.importEncryptedBytes(payloadBytes, LIVE_FILE);
    await SQL.deletePath(STAGING_FILE).catch(() => {});
    return { installed: true };
  }

  global.StackroomBackup = { exportEncryptedDatabase, importEncryptedDatabase };
})(window);
