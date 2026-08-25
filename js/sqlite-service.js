/* ============================================================
   sqlite-service.js — Stackroom Database Architecture Upgrade
   ------------------------------------------------------------
   Thin main-thread proxy to js/sqlite-worker.js (OPFS only works
   in a Worker — see that file's header for the verified API
   sources this is built against).

   ACTIVATION STATUS: VENDORED (2026-08-25)
   The real sqlite3mc-2.5.0-sqlite-3.53.4-wasm.zip release has been
   unzipped into /sqlite/jswasm/ (sqlite3.mjs, sqlite3.wasm,
   sqlite3-opfs-async-proxy.js — see that folder's UPSTREAM-README.txt
   for the upstream project's own notes) and js/sqlite-worker.js's
   SQLITE_LOADER_PATH points at the confirmed real file. ENGINE_VENDORED
   is now true. What's STILL not done: this has never been exercised in
   an actual browser (no browser in this sandbox) — the cipher default
   assumed below (CIPHER_NAME) should be double-checked with
   `PRAGMA cipher;` on a freshly created database before you trust it
   for the README/UI, and the full Part 60/61 test matrix still needs
   to run for real before this is production-ready.
   ============================================================ */
(function (global) {
  'use strict';

  const CIPHER_NAME = 'chacha20'; // SQLite3 Multiple Ciphers' documented default, and confirmed present in the vendored binary's string table — but "present" isn't "default for a fresh DB"; verify with `PRAGMA cipher;` in a real browser (see header) before trusting this in the UI/README
  const WORKER_PATH = 'js/sqlite-worker.js';

  const ENGINE_VENDORED = true; // flipped 2026-08-25 — see header

  let worker = null;
  let nextId = 1;
  const pending = new Map();

  function engineAvailable() {
    return ENGINE_VENDORED;
  }

  function missingEngineError() {
    const err = new Error(
      'Encrypted SQLite engine is not activated in this build. See the header comment in js/sqlite-service.js for the exact steps (download the official sqlite3mc-*-wasm.zip release, unzip into /sqlite/, set ENGINE_VENDORED = true). The IndexedDB database remains authoritative and fully functional until then.'
    );
    err.code = 'SQLITE_ENGINE_MISSING';
    return err;
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(WORKER_PATH, { type: 'module' });
    worker.onmessage = (ev) => {
      const { id, ok, result, error } = ev.data || {};
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      ok ? p.resolve(result) : p.reject(Object.assign(new Error(error), { code: 'SQLITE_WORKER_ERROR' }));
    };
    worker.onerror = (ev) => {
      // Fires for e.g. a 404 on WORKER_PATH or the loader inside it —
      // surfaces as a rejection on whatever call is currently pending
      // rather than an unhandled error, so callers get a real Promise
      // rejection instead of a silent hang.
      for (const [id, p] of pending) { p.reject(new Error('SQLite worker failed to start: ' + (ev.message || 'see browser console'))); pending.delete(id); }
    };
    return worker;
  }

  function call(cmd, payload) {
    if (!engineAvailable()) return Promise.reject(missingEngineError());
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ensureWorker().postMessage({ id, cmd, payload });
    });
  }

  function hexFromDek(dekBytes) {
    return Array.from(dekBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function open(fileName, dekBytes) {
    return call('open', { fileName, dekHex: dekBytes ? hexFromDek(dekBytes) : null, cipher: CIPHER_NAME });
  }
  async function exec(sql, params) { return call('exec', { sql, params }); }
  async function run(sql, params) { return call('run', { sql, params }); }
  /** Runs an ordered array of {sql, params} steps inside one BEGIN/COMMIT,
   *  rolling back on any failure (Part 31). See js/sql-statements.js's
   *  issueBookSteps()/returnBookSteps() for how these arrays are built. */
  async function transaction(steps) { return call('transaction', steps); }
  async function close() { if (!engineAvailable()) return; return call('close', {}); }

  async function checkpoint() {
    // No dedicated WAL checkpoint is exposed by the worker yet — the
    // opfs-sahpool VFS's own commit semantics (each exec's implicit
    // transaction, or an explicit BEGIN/COMMIT) already durably persist
    // to OPFS without a separate checkpoint step being required for
    // Stackroom's usage pattern (no long-lived WAL mode requirement
    // here). Left as a documented no-op rather than a guessed API call.
    return true;
  }

  async function exportEncryptedBytes(fileName) {
    return call('exportFile', { fileName: fileName || 'stackroom-library.sqlite' });
  }
  async function importEncryptedBytes(bytes, fileName) {
    return call('importFile', { fileName: fileName || 'stackroom-library.sqlite', bytes });
  }
  async function deletePath(path) { return call('deletePath', { path }); }

  /** Real, live feature-detection — distinct from engineAvailable()
   *  (which only reflects "the engine files are vendored in this
   *  project"). Added after a real-device test came back silent with
   *  no way to tell whether the files were missing, the browser lacked
   *  a required API, or something else failed — this makes that
   *  distinction visible in the Database Management panel instead of
   *  requiring remote devtools to diagnose. */
  function browserCapabilities() {
    return {
      secureContext: !!global.isSecureContext,
      worker: typeof Worker !== 'undefined',
      moduleWorkerLikely: typeof Worker !== 'undefined', // can't be feature-detected more precisely than this without attempting construction
      wasm: typeof WebAssembly !== 'undefined',
      opfs: !!(global.navigator && global.navigator.storage && typeof global.navigator.storage.getDirectory === 'function')
    };
  }

  function status() {
    return {
      engineAvailable: engineAvailable(),
      capabilities: browserCapabilities(),
      storage: 'OPFS (opfs-sahpool VFS — no COOP/COEP headers required, single-tab-at-a-time)',
      cipher: engineAvailable() ? CIPHER_NAME : null,
      note: engineAvailable() ? null : 'Engine not activated — see js/sqlite-service.js header for the 5 setup steps.'
    };
  }

  global.StackroomSQLite = { open, exec, run, transaction, checkpoint, close, exportEncryptedBytes, importEncryptedBytes, deletePath, status, engineAvailable };
})(window);
