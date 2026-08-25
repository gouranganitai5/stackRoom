/* ============================================================
   sqlite-worker.js — Stackroom Database Architecture Upgrade
   ------------------------------------------------------------
   OPFS is only reachable from a Worker thread, not the main UI
   thread (confirmed in SQLite's own persistence docs), so the
   actual sqlite3mc engine lives here; sqlite-service.js on the
   main thread is a thin postMessage proxy around it.

   VERIFICATION STATUS (be precise about this)
   The API calls below are not guessed — each is grounded in one
   of:
     (a) the official @sqlite.org/sqlite-wasm README (sqlite3InitModule,
         installOpfsSAHPoolVfs, oo1 API, cross-origin-isolation notes),
     (b) SQLite's own persistence.md docs (opfs vs opfs-sahpool VFS
         trade-offs: opfs needs COOP/COEP + SharedArrayBuffer and
         supports multi-tab concurrency; opfs-sahpool does not need
         those headers but holds an exclusive lock per open handle,
         so a second tab opening the same DB fails — acceptable here,
         since Stackroom is a single-desk admin tool, not a multi-tab
         app),
     (c) a real user's working code against THIS EXACT precompiled
         bundle, filed in utelle/SQLite3MultipleCiphers issue #213
         (`db.exec("PRAGMA cipher = 'chacha20';")`, `db.exec("PRAGMA key
         = \"x'<hex>'\";")`),
     (d) the SQLite3 Multiple Ciphers PRAGMA reference docs (key/hexkey/
         cipher/rekey semantics, hex-blob key literal syntax).
   None of this has been executed — there is no browser in this
   sandbox. Treat it as "written against verified documentation," one
   step more trustworthy than an invented API, but still unverified
   by actual execution (Part 61's distinction).

   CONFIRMED AGAINST THE REAL FILES (2026-08-25, sqlite3mc-2.5.0-sqlite-3.53.4-wasm.zip)
   Unzipped and inspected directly — no longer inferred:
     - Loader is jswasm/sqlite3.mjs, `export default sqlite3InitModule`
       (grepped from the actual file).
     - `installOpfsSAHPoolVfs` / `OpfsSAHPoolDb` are present in this
       build (grepped from the actual file) — the opfs-sahpool VFS
       choice below is confirmed available, not assumed.
     - The compiled .wasm binary's string table contains "SQLite3
       Multiple Ciphers 2.5.0" plus cipher identifiers chacha20,
       aes128cbc, aes256cbc, ascon128, sqlcipher — this really is the
       multi-cipher build, not plain SQLite.
     - PRAGMA names `hexkey`/`hexrekey` are present in the binary's
       string table, confirming the hex-literal key-setting path used
       below is real and compiled in (used in place of the
       `PRAGMA key="x'<hex>'"` blob-literal form from the earlier
       draft — `PRAGMA hexkey='<hex>'` is the more direct spelling for
       "set the raw key from hex, no passphrase KDF").
     - `sqlite3-opfs-async-proxy.js` ships alongside the loader; it is
       NOT required for opfs-sahpool (that VFS uses synchronous
       FileSystemSyncAccessHandle directly inside this worker, no
       separate proxy worker) — it's only needed for the default
       `opfs` VFS, which this project deliberately does not use (see
       COOP/COEP note below). Vendored anyway in case a future change
       needs it.
   STILL NOT CONFIRMED: which cipher a freshly-created database
   actually uses by default (CIPHER_NAME in sqlite-service.js still
   says 'chacha20' per the project's documented default) — run
   `PRAGMA cipher;` once in a real browser before trusting that value
   for the README/UI. No browser is available to do that here.
   ============================================================ */
const SQLITE_LOADER_PATH = '../sqlite/jswasm/sqlite3.mjs'; // confirmed real path, relative to this worker file's own location (js/sqlite-worker.js)

let sqlite3 = null;
let poolUtil = null;
let db = null;

function toHexKey(dekBytes) {
  return Array.from(dekBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function ensureEngine() {
  if (sqlite3) return;
  const { default: sqlite3InitModule } = await import(SQLITE_LOADER_PATH);
  sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: (e) => console.error('[sqlite3]', e) });
  // opfs-sahpool: no COOP/COEP requirement (source (b) above) — the
  // right choice for a GitHub-Pages-style static host with no control
  // over response headers.
  poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: 'stackroom-opfs' });
}

async function open({ fileName, dekHex, cipher }) {
  await ensureEngine();
  if (db) { try { db.close(); } catch (e) {} db = null; }
  db = new poolUtil.OpfsSAHPoolDb(fileName);
  // Key MUST be set before any other SQL touches the database (source
  // (c)/(d) above) — including our own schema-creation DDL.
  if (dekHex) {
    if (cipher) db.exec(`PRAGMA cipher = '${cipher}';`); // e.g. 'chacha20' (the library's documented default, and the only scheme confirmed compiled with plaintext_header_size support pre-2.2.0-era caveats — see header) — CONFIRM in a real browser (PRAGMA cipher;) before trusting this for a freshly created DB
    // plaintext_header_size=32: WITHOUT this, the cipher stores its
    // random per-database salt in the first 16 bytes — exactly where
    // the plaintext "SQLite format 3" magic normally lives — so an
    // exported file would NOT be importable via poolUtil.importDb()
    // (confirmed by reading its actual source in sqlite3.mjs: it
    // hard-rejects any input whose first 16 bytes aren't literally
    // "SQLite format 3"). Setting this to 32 (SQLite3MC's own
    // documented/recommended value, matching SQLCipher's convention)
    // keeps that region readable so cross-device .db.enc import can use
    // the public API — the trade-off, per the project's own docs, is
    // that the salt can no longer live in the header and must be
    // captured at creation time and re-supplied on reopen (see the
    // STILL UNVERIFIED note below). All actual table data remains
    // fully encrypted either way — this only affects 32 header bytes.
    db.exec(`PRAGMA plaintext_header_size = 32;`);
    db.exec(`PRAGMA hexkey = '${dekHex}';`); // confirmed-compiled-in PRAGMA name (see header) — sets the raw key directly from hex with no additional passphrase KDF, since key-manager.js already did all the KDF work
    // STILL UNVERIFIED (needs a real browser): with plaintext_header_size
    // set, the cipher salt must be captured on creation and re-supplied
    // on every reopen (per the project's own docs). The JS-level access
    // path for this — a PRAGMA, or only the C-API function
    // sqlite3mc_codec_data() via lower-level wasm exports — was not
    // confirmed from static inspection alone. Whoever does the first
    // real-browser test pass: query for it here and store the result in
    // the `meta` table (NOT in key-manager.js's PIN/Recovery-wrapped
    // records — this salt is not secret, it's a public parameter of the
    // cipher construction) before relying on export/import in production.
  }
  return { opened: true };
}

function bindParamsFor(params) {
  // oo1.DB accepts an object keyed by ':name' for named binds. Our SQL
  // catalog (sql-statements.js) uses bare `:name` placeholders, so this
  // just needs the `:` prefix restored on each key.
  if (!params) return undefined;
  const out = {};
  for (const k of Object.keys(params)) out[':' + k] = params[k];
  return out;
}

function exec({ sql, params }) {
  if (!db) throw new Error('Database is not open.');
  const rows = [];
  db.exec({ sql, bind: bindParamsFor(params), rowMode: 'object', callback: (row) => rows.push(row) });
  return rows;
}

function run({ sql, params }) {
  if (!db) throw new Error('Database is not open.');
  db.exec({ sql, bind: bindParamsFor(params) });
  return { changes: db.changes ? db.changes() : undefined };
}

function transaction(steps) {
  if (!db) throw new Error('Database is not open.');
  const results = [];
  db.exec('BEGIN');
  try {
    for (const step of steps) {
      const rows = [];
      db.exec({ sql: step.sql, bind: bindParamsFor(step.params), rowMode: 'object', callback: (r) => rows.push(r) });
      results.push(rows);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
    throw e;
  }
  return results;
}

function close() {
  if (db) { db.close(); db = null; }
}

function exportFile(fileName) {
  if (!poolUtil) throw new Error('OPFS pool is not initialized.');
  // Confirmed real method (read from sqlite3.mjs's OpfsSAHPool class):
  // returns the raw on-disk bytes, still fully encrypted — this is
  // exactly the .db.enc payload, untouched by any second layer of
  // encryption on our part.
  return poolUtil.exportFile(fileName);
}

function importFile(fileName, bytes) {
  if (!poolUtil) throw new Error('OPFS pool is not initialized.');
  // Confirmed real method — but see open()'s plaintext_header_size
  // comment: this will reject bytes that don't start with the literal
  // "SQLite format 3" header, which is why open() sets
  // plaintext_header_size=32 on every database this worker creates.
  return poolUtil.importDb(fileName, bytes);
}

function deletePath(path) {
  if (!poolUtil) throw new Error('OPFS pool is not initialized.');
  return poolUtil.deletePath(path); // confirmed real method (read from sqlite3.mjs's OpfsSAHPool class)
}

self.onmessage = async (ev) => {
  const { id, cmd, payload } = ev.data || {};
  try {
    let result;
    switch (cmd) {
      case 'open': result = await open(payload); break;
      case 'exec': result = exec(payload); break;
      case 'run': result = run(payload); break;
      case 'transaction': result = transaction(payload); break;
      case 'exportFile': result = exportFile(payload.fileName); break;
      case 'importFile': result = importFile(payload.fileName, payload.bytes); break;
      case 'deletePath': result = deletePath(payload.path); break;
      case 'close': result = close(); break;
      default: throw new Error('Unknown worker command: ' + cmd);
    }
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    self.postMessage({ id, ok: false, error: (e && e.message) || String(e) });
  }
};
