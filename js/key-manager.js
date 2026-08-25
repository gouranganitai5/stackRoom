/* ============================================================
   key-manager.js — Stackroom Database Architecture Upgrade
   ------------------------------------------------------------
   Owns the lifecycle of the SQLite Database Encryption Key (DEK):
   generation, wrapping under the Login PIN, wrapping under the
   Recovery Code, unwrapping, and re-wrapping on PIN change /
   recovery-based reset. Built on the pure primitives in
   crypto-service.js.

   SCOPE — READ BEFORE WIRING THIS INTO THE APP
   This DEK protects the NEW encrypted SQLite database (Part 3/7
   of the upgrade spec), not the app's existing per-row IndexedDB
   AES-GCM encryption (that key is `getDek()`/`cryptoKeys.dek` in
   the main script — untouched, still working exactly as before).
   The two are intentionally independent (Part 21: "the old DEK and
   new SQLite DEK do NOT have to be identical").

   Consequently this module has NOTHING to wrap until a SQLite
   database actually exists:
     - Fresh install ("Create New Library"): the DEK is created and
       wrapped immediately, before the SQLite file is created.
     - Existing install: the DEK is created and wrapped as the LAST
       step of a successful, verified IndexedDB → SQLite migration
       (see migration.js), using the PIN/Recovery Code the admin
       already authenticated with — never before, and never as a
       side effect of ordinary login.
   Until one of those has happened, hasWrappedDek() returns false
   and the app's existing PIN/Recovery/PIN-change code paths should
   simply not call into this module — see the integration comments
   in index.html's Security panel handlers.

   STORAGE
   This module never talks to Dexie directly. The caller supplies a
   tiny "meta store" adapter — { get(key), put(record), del(key) }
   — so today that's `libraryDB.meta` (via a thin wrapper) and,
   once SQLite is authoritative, it becomes the SQLite `meta` table
   through the same adapter shape, with zero changes required here.
   ============================================================ */
(function (global) {
  'use strict';

  const KEY_PIN_WRAP = 'sqliteDekWrapPin';
  const KEY_RECOVERY_WRAP = 'sqliteDekWrapRecovery';

  // In-memory only, for the lifetime of the tab session. Never written to
  // sessionStorage/localStorage/IndexedDB in plaintext form (Part 6/7/45).
  let cachedDekBytes = null;

  function requireCrypto() {
    if (!global.StackroomCrypto) throw new Error('crypto-service.js must be loaded before key-manager.js');
    return global.StackroomCrypto;
  }

  async function hasWrappedDek(metaStore) {
    const rec = await metaStore.get(KEY_PIN_WRAP);
    return !!rec;
  }

  /** First-install / post-migration: create a brand-new random DEK and
   *  wrap it under both the PIN and the Recovery Code. Caller is
   *  responsible for having already collected/verified both secrets
   *  (this module never prompts for input itself). Returns the raw DEK
   *  bytes so the caller can immediately key the new SQLite database —
   *  the raw bytes are also cached in memory for the current session. */
  async function createAndWrapDek(metaStore, pin, recoveryCode) {
    const C = requireCrypto();
    const dekBytes = C.generateDek();
    const pinRecord = await C.wrapDek(dekBytes, pin);
    const recoveryRecord = await C.wrapDek(dekBytes, recoveryCode);
    await metaStore.put({ key: KEY_PIN_WRAP, ...pinRecord, createdAt: new Date().toISOString() });
    await metaStore.put({ key: KEY_RECOVERY_WRAP, ...recoveryRecord, createdAt: new Date().toISOString() });
    cachedDekBytes = dekBytes;
    return dekBytes;
  }

  async function unwrapWithPin(metaStore, pin) {
    const C = requireCrypto();
    const rec = await metaStore.get(KEY_PIN_WRAP);
    if (!rec) throw new Error('No PIN-wrapped database key exists yet.');
    const dekBytes = await C.unwrapDek(rec, pin);
    cachedDekBytes = dekBytes;
    return dekBytes;
  }

  async function unwrapWithRecovery(metaStore, recoveryCode) {
    const C = requireCrypto();
    const rec = await metaStore.get(KEY_RECOVERY_WRAP);
    if (!rec) throw new Error('No Recovery-Code-wrapped database key exists yet.');
    const dekBytes = await C.unwrapDek(rec, recoveryCode);
    cachedDekBytes = dekBytes;
    return dekBytes;
  }

  /** PIN change (Part 10): re-wrap the SAME DEK under the new PIN.
   *  Requires the DEK already be unwrapped this session (i.e. the admin
   *  is authenticated) — never re-derives it from scratch. Does not
   *  touch the Recovery-wrapped record. */
  async function rewrapForNewPin(metaStore, newPin) {
    const C = requireCrypto();
    if (!cachedDekBytes) throw new Error('Database key is not unlocked — cannot re-wrap for a new PIN.');
    const pinRecord = await C.wrapDek(cachedDekBytes, newPin);
    await metaStore.put({ key: KEY_PIN_WRAP, ...pinRecord, createdAt: new Date().toISOString() });
  }

  /** Recovery Code regeneration (Part 9): re-wrap the SAME DEK under the
   *  new Recovery Code. Does not touch the PIN-wrapped record. */
  async function rewrapForNewRecovery(metaStore, newRecoveryCode) {
    const C = requireCrypto();
    if (!cachedDekBytes) throw new Error('Database key is not unlocked — cannot re-wrap for a new recovery code.');
    const recoveryRecord = await C.wrapDek(cachedDekBytes, newRecoveryCode);
    await metaStore.put({ key: KEY_RECOVERY_WRAP, ...recoveryRecord, createdAt: new Date().toISOString() });
  }

  /** Forgot-PIN flow (Part 9): Recovery Code unlocks the DEK, admin sets
   *  a brand-new PIN, DEK is re-wrapped under it. Existing database is
   *  never touched/recreated. */
  async function resetPinViaRecovery(metaStore, recoveryCode, newPin) {
    await unwrapWithRecovery(metaStore, recoveryCode);
    await rewrapForNewPin(metaStore, newPin);
  }

  function getCachedDek() {
    return cachedDekBytes;
  }

  /** Lock: drop the plaintext DEK from memory (page refresh, explicit
   *  logout, or session expiry). The wrapped records on disk are
   *  untouched — this only affects what's unlocked in THIS tab. */
  function lock() {
    if (cachedDekBytes) requireCrypto().secureWipe(cachedDekBytes);
    cachedDekBytes = null;
  }

  global.StackroomKeyManager = {
    hasWrappedDek,
    createAndWrapDek,
    unwrapWithPin,
    unwrapWithRecovery,
    rewrapForNewPin,
    rewrapForNewRecovery,
    resetPinViaRecovery,
    getCachedDek,
    lock
  };
})(window);
