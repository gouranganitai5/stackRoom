# Stackroom — School Library System (v3, Fine/Grace + Master Reset edition)

## 🗄️ Database Architecture Upgrade (latest round) — read this first

This round adds the scaffolding for an **encrypted SQLite-in-OPFS**
database to replace IndexedDB as the authoritative store, per a detailed
spec covering PIN/Recovery-Code-wrapped key management, non-destructive
IndexedDB→SQLite migration, and portable encrypted `.db.enc` backups.
**Read this section before assuming any of it is active** — the honest
summary is: the architecture, key-management, migration engine, and UI
are built and wired in; the one piece that could not be completed in
this environment is the actual encrypted-SQLite WASM engine binary.

### What's real and working today
- `js/crypto-service.js` — versioned KDF (PBKDF2-SHA256, 210k
  iterations; Argon2id used automatically if a real Argon2id WASM
  build is ever loaded as `window.argon2`, never simulated) and
  AES-256-GCM (genuine WebCrypto `crypto.subtle`, not a home-rolled
  cipher) authenticated wrap/unwrap of a random 256-bit Database
  Encryption Key (DEK).
- `js/key-manager.js` — DEK lifecycle: create + wrap under PIN and
  Recovery Code, unwrap under either, re-wrap on PIN change or
  Recovery Code regeneration, unlock-via-recovery-then-set-new-PIN.
  Wired into the existing `setAuthPin()`, `initializeRecoveryCode()`,
  and `resetPinWithRecovery()` functions in `index.html` as additive,
  try/catch-guarded hooks that are a safe no-op today (see below) and
  activate automatically once a SQLite DEK exists.
- `js/db-abstraction.js` — the storage-abstraction layer (spec Part 32):
  a stable set of logical operations (`loadAll`, `persistData`,
  `persistSettings`, etc.) that today delegate straight through to the
  existing, unchanged Dexie functions, and a migration-state machine
  (`NOT_STARTED → IN_PROGRESS → DATA_IMPORTED → VERIFYING → VERIFIED →
  COMPLETED`, or `FAILED` at any point, always retry-safe) persisted in
  the existing `meta` table.
- `js/migration.js` — reads a full decrypted IndexedDB snapshot,
  computes a SHA-256 fingerprint per record plus an aggregate
  fingerprint per table (not just a record count), and would compare
  those against a post-insert SQLite read-back before ever marking
  migration `VERIFIED`. **IndexedDB is only ever read during
  migration — there is no code path in this file that writes to or
  deletes the Dexie tables.**
- `js/backup-service.js` — `.db.enc` export/import envelope format and
  validation flow, gated on SQLite actually being authoritative.
- `sqlite/schema.sql` — the target relational schema (Parts 25-30),
  transliterated directly from the actual field lists found in
  `index.html`'s form/issue/return/audit code (not guessed from Dexie's
  index list, which only covers a handful of queried fields). Pure DDL,
  reviewable now, executable once an engine exists.
- `js/sql-statements.js` — parameterized SQL (named `:params`, injection-
  safe by construction) for every `db-abstraction.js` operation against
  that schema, including the atomic `BEGIN`/`COMMIT` step sequences for
  Issue and Return (Part 31). Each statement is commented with which
  actual function in `index.html` it mirrors — e.g. available-copies is
  always a live `COUNT()` against `transactions`, never a stored
  decrementing field, because that's how `availableCopiesFor()` already
  works. Pure text; hand-verified against the source logic, not
  execution-tested (no engine to run it against here).
- A **Database Management** panel in Settings showing live status
  (active backend, storage, SQLite engine presence, encryption/cipher,
  migration state, whether a SQLite key has been wrapped yet) and
  Prepare/Export/Import actions.

### The engine: ACTIVATED with a real, verified vendored build (2026-08-25)

The blocker from earlier rounds is resolved. `utelle/SQLite3MultipleCiphers`
publishes official precompiled WASM releases — asset
`sqlite3mc-2.5.0-sqlite-3.53.4-wasm.zip` on their
[GitHub Releases page](https://github.com/utelle/SQLite3MultipleCiphers/releases) —
which you provided and I unzipped and inspected directly. `/sqlite/jswasm/`
now contains the real `sqlite3.mjs` (loader), `sqlite3.wasm` (binary), and
`sqlite3-opfs-async-proxy.js` from that release.

**Confirmed by reading the actual vendored source (not assumed):**
- `sqlite3.wasm`'s string table literally contains `"SQLite3 Multiple
  Ciphers 2.5.0"` and the cipher names `chacha20`, `aes128cbc`,
  `aes256cbc`, `ascon128`, `sqlcipher` — this is genuinely the
  multi-cipher build, not plain SQLite.
- `installOpfsSAHPoolVfs` / `OpfsSAHPoolDb` / `exportFile()` /
  `importDb()` / `deletePath()` all exist as real methods in
  `sqlite3.mjs` — every one of `js/sqlite-worker.js`'s calls is
  grounded in a specific line I read, not guessed.
- The `PRAGMA hexkey` / `PRAGMA plaintext_header_size` / `PRAGMA cipher`
  names are all present in the binary's string table.

**A real design issue this surfaced, and how it's handled:** by default,
an encrypted database's first 16 bytes hold the cipher's random salt —
not a plaintext `"SQLite format 3"` header. I confirmed by reading
`importDb()`'s actual code that it **hard-rejects** any input not
starting with that literal string, which would have silently broken
`.db.enc` import. Fix: `js/sqlite-worker.js` now sets
`PRAGMA plaintext_header_size = 32` on every database it creates —
SQLite3 Multiple Ciphers' own documented, intentional feature for
exactly this interoperability need (same convention SQLCipher uses for
iOS). Only those 32 header bytes become readable; all table data stays
fully encrypted. `js/backup-service.js` now does a real stage-then-
validate-then-swap import using `importDb()` + `deletePath()`, never
touching the live database until the staged import passes a schema
check.

**Still genuinely unverified — no browser exists in this environment:**
- Which cipher a freshly created database actually defaults to
  (`CIPHER_NAME = 'chacha20'` in `js/sqlite-service.js` is the
  project's documented default and is confirmed present in the binary,
  but "present" isn't "default" — run `PRAGMA cipher;` once for real).
- The exact JS-level path for retrieving/re-supplying the cipher's
  internal salt across devices when `plaintext_header_size` is set
  (the docs describe a C-API function, `sqlite3mc_codec_data()`; I
  could not confirm from static inspection alone whether it's also
  reachable as a plain PRAGMA in this build, or only via lower-level
  wasm exports — flagged in `js/sqlite-worker.js`'s `open()` as the one
  remaining piece for whoever does the first real-browser test pass).
- The entire Part 60/61 test matrix — migration, refresh/restart, PIN
  change, recovery, export, import, cross-device, offline. All of the
  above is "written against confirmed real APIs," which is a genuinely
  different (much stronger) claim than earlier rounds' "designed, not
  vendored" — but it is still not "tested in a running browser."

`js/sqlite-service.js`'s `ENGINE_VENDORED` flag is now `true`.

### What changes for an existing admin, today
**Nothing.** Login, PIN change, Recovery Code, Issue/Return, Reports,
Master Reset, the existing encrypted JSON backup, QR/barcode scanning,
and offline/PWA behavior are all untouched — this round only *adds*
files and one new Settings panel; it does not remove or rewire any
existing code path. The one behavior that has **not** been changed
(because it depends on the missing engine) is Part 11's "refresh always
re-asks for the PIN" — the app still uses its existing session-token
behavior (refresh doesn't re-prompt within the session lifetime) until
SQLite is authoritative, at which point that becomes the SQLite DEK's
lock/unlock behavior as specified.

### Testing performed
**Static code inspection and Node.js syntax-checking only** (`node
--check` on every new file and the full extracted inline script — all
pass). **No real browser testing was performed** for this round — there
is no browser available in this build environment, so nothing here is a
substitute for running the Part 60/61 test matrix (fresh install, same
device, refresh, browser restart, wrong PIN, recovery, PIN change,
export, import, cross-device, migration + interruption, Master Reset,
offline) against a real Chromium/Firefox instance once the SQLite
engine is vendored.

## ⚠️ Security Hardening Pass (previous round) — read this first

This round did a full security hardening pass on `index.html` and `sw.js`,
requested as a large, explicit checklist (encryption at rest, XSS fixes,
PIN/backup strengthening, input validation, CSP, Master Reset
confirmation, session expiry, and more). Full detail is in
`SECURITY_AUDIT_REPORT.md`; the short version:

**Done and verified in a real browser** (Chromium via Playwright, real
IndexedDB, real Web Crypto — not just read-through): Book/transaction ID
attribute-injection XSS, cryptographically-secure random IDs,
constant-time PIN comparison, PIN minimum raised 4→6 digits (backward
compatible), backup PBKDF2 iteration bounds, 12-character minimum backup
password, field-length limits + record validators on Excel/QR/backup
import, Master Reset typed confirmation ("DELETE LIBRARY"), session
token expiry (12h) + rotation, a CSP, and — the big one —
**field-level AES-256-GCM encryption at rest** for books, transactions,
students, settings, and the audit log, with a resumable, crash-safe
migration.

**⚠️ IMPORTANT — supersedes the note directly below.** An earlier round
of this project (the note right under this one) explicitly decided
*against* encryption at rest, on the reasoning that a PIN-derived key
can't survive a page refresh without either re-prompting for the PIN or
storing something that lets the app re-derive the key without the PIN.
That tension is real, and this round resolves it the way that note's own
last line predicted: the DEK is a **random** key (not derived from the
PIN) generated once with `crypto.subtle.generateKey(..., extractable:
false, ...)` and persisted as a non-extractable `CryptoKey` object
(never raw bytes) in IndexedDB. Browsers support structured-cloning a
non-extractable `CryptoKey` into IndexedDB specifically so this pattern
works: refresh-persistent login keeps working exactly as before, and the
DEK is never exposed as exportable bytes to any code, including this
app's own. See §34 in `SECURITY_AUDIT_REPORT.md` for the honest limit of
what this protects against (this does **not** protect against malicious
JS already running in the page — nothing browser-side can).

**Explicitly NOT done, with reasons:**
- **CDN vendoring** (bundling Dexie/html5-qrcode/etc. locally) — the
  environment this work was done in has no network access to download
  them. The app still loads these six libraries from CDN at runtime; the
  CSP restricts `script-src` to only those specific origins.
- **HTTP security headers** (HSTS, X-Content-Type-Options,
  Permissions-Policy, COOP) — this project has no server/hosting config
  file to add them to. See "Deploying this" below for how to add them on
  common static hosts.
- **Audit-chain hashing** — skipped because there's no audit-log viewer
  anywhere in the app to check a hash chain against; flagged as a design
  gap rather than building verification with nothing to verify against.
- Full data-integrity checker (§27 of the original spec — orphaned
  transactions, negative fines, etc. across the live DB) and a
  dedicated `validateBackupPayload()`/`validateSettings()` — settings
  and backup records are length/type/range-checked inline at their
  actual call sites, just not as separately-named functions.

**Real-browser testing performed this round** (in addition to the
pre-existing testing described further down this README, which this
round did not re-run since it didn't touch that surface): 20 end-to-end
checks against an actual headless Chromium instance (via Playwright),
driving the real UI — fresh-DB PIN setup with the new 6-digit minimum,
the mandatory recovery-code acknowledgment modal, adding a book through
the real Book Registry form, reading the **raw IndexedDB row directly**
(bypassing the app entirely) to confirm it's genuine ciphertext with no
plaintext title/author, a full page reload confirming both login
persistence and correct decrypt-on-load, sign-out/wrong-PIN/lockout
through the real keypad, and the Master Reset typed-confirmation gate.
Separately, the encryption/migration logic itself was unit-tested (13
tests) against Node's native Web Crypto — round-trip correctness, IV
uniqueness, AES-GCM tamper detection, and crash-safe/resumable
migration — which is how a real bug (the audit-log migration dropping
its primary key and duplicating rows forever) was caught and fixed
*before* it reached this file.

**What this round did NOT verify in a browser**: QR scanning (needs a
camera + the html5-qrcode CDN library, unavailable in this sandbox),
Excel import/export, PDF generation, and PWA installability. These
weren't touched by this round's changes and their prior testing status
(described further down) is unchanged — but they weren't re-confirmed
working either.

### Deploying this (for the HTTP security headers gap above)
If you host this as static files, most platforms let you add response
headers via a small config file dropped next to `index.html`:
- **Netlify**: a `_headers` file
- **Vercel**: `headers` in `vercel.json`
- **Cloudflare Pages**: a `_headers` file (same format as Netlify)
- **GitHub Pages**: does not support custom headers — you'd need a
  different host or a CDN/reverse proxy in front of it
- **Nginx/Apache**: `add_header`/`Header set` directives in the server
  config

A reasonable starting point, once you know which host you're using:
```
Content-Security-Policy: <copy the meta tag's content from index.html — moving it to a header also makes frame-ancestors actually work, unlike the meta tag>
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(self), microphone=(), geolocation=()
Cross-Origin-Opener-Policy: same-origin
```
(Camera access needs to stay allowed for `self` — QR scanning uses it.)

---

**Read this note first if you asked for encryption-at-rest for IndexedDB.**
*(Historical — see the superseding note above. Left in place rather than
deleted, per this project's own "never silently discard prior
documentation" principle.)*
Before writing any code for this round, I flagged a real conflict in the
brief: "decryption keys live only in memory, derived from the Admin PIN"
and "refreshing the page must not force PIN re-entry" cannot both be
literally true — JS memory is wiped on every reload, so a PIN-derived key
cannot survive a refresh without either re-asking for the PIN (changing
existing UX) or stashing something that lets the app re-derive the key
*without* the PIN (which defeats the point of PIN-derived encryption).
You chose to keep the current no-relogin-on-refresh session behavior, so
**this round does not add field-level AES-GCM encryption of IndexedDB
records.** Everything else from that part of the brief that's actually
compatible with persistent sessions is unchanged and already true: the
Admin PIN and Recovery Code are still never stored in plaintext, only as
PBKDF2-SHA256 verifier hashes; the encrypted JSON backup (AES-256-GCM +
PBKDF2, unique salt/IV per export) is untouched and still the only place
your data leaves the browser other than as live IndexedDB records. If you
want to revisit real encryption-at-rest later, the honest version of it
requires accepting a PIN prompt on every fresh page load/tab reopen.

## What changed in this round

### Fine & Grace Period system (new)
One authoritative set of functions decides every loan's status —
`getLoanStatus()`, `getGraceDaysRemaining()`, `getFineDays()`,
`calculateCurrentFine()` — and every screen (Dashboard, Issued, Overdue,
Return, Returned, Transactions) calls into these instead of each
re-implementing the date math. Grace Period starts the day *after* the
due date (Due Date itself is never a grace or fine day); Fine Days only
start counting once Grace Period is fully over. Money is stored and
calculated in integer paise, never rupee floats, so nothing can drift.

Admin-configurable in **Settings → Library Rules · Fine & Return
Policy**: Grace Period (whole days, ≥0) and Fine Amount per day (₹,
≥0). Both are validated before saving and require the existing Admin
PIN (same `verifyAuthPin()` PBKDF2 check login already uses — no second
PIN system), and both take effect immediately across every open view,
with no reload needed. Changing the Fine Amount immediately updates the
fine shown on every *active* overdue loan; a loan that's already been
returned keeps the fine it was actually given at return time
(`fineDays`/`fineAmountPaise` are frozen onto the transaction the
moment it's returned — see `finalizeReturnFineFields()` — that's the
`currentCalculatedFine` vs `finalRecordedFine` distinction).

### Early Return (new)
Returning a book before its due date already worked functionally (the
Return flow never blocked it) — it just wasn't labeled or guaranteed
₹0 fine. It now explicitly shows "Early Return" in the confirm card and
in the Returned Books table, and is centrally guaranteed ₹0 fine by the
same `getLoanStatus()` function everything else uses, so there's no
separate early-return code path that could disagree with the general
fine logic.

### Fine payment recording (new, minimal)
No external payment gateway. A returned loan with a nonzero fine gets a
"Mark Paid" button in Returned Books; Fine Due vs Fine Paid is only ever
set by that explicit action, never assumed.

### Return workflow (updated)
The Return Book confirm card now shows a live preview of the outcome
(Early Return / On-time / Grace Period / Fine Applicable + amount)
*before* confirming — but the fine actually committed is always
recalculated fresh at the moment "Mark as Returned" is clicked, never
reused from that preview. Quick-return buttons in Issued/Overdue tables
go through the same `markTransactionReturned()` function as the full
Return Book flow, so there's exactly one return code path, not three.

### Master Reset (rewritten)
Previously cleared the entire `meta` table, including the PIN verifier
and recovery code, and reloaded the page — meaning a "reset" also logged
the admin out and demanded a brand-new PIN. It's now scoped precisely:
- **Preserved:** admin PIN verifier + lockout state, recovery code
  verifier + lockout state, the active session token. The admin stays
  logged in, on the same screen, with the same PIN and recovery code.
- **Erased:** books, transactions, students, settings (including
  Grace Period/Fine Amount, which reset to 0), and audit history.
- A new 3-way prompt (**Backup & Continue** / **Continue Without
  Backup** / **Cancel**) appears before the PIN-confirmation step that
  was already there; choosing Backup routes through the exact same
  encrypted-export code the Settings page uses (`runBackupExport()`),
  and Master Reset only proceeds once that backup has genuinely
  completed — a cancelled password prompt or a failed export never
  silently falls through to the destructive reset.
- `master_reset_started` / `master_reset_backup_created` /
  `master_reset_completed` are audit-logged (never the PIN, recovery
  code, or any erased library data) — the `master_reset_completed`
  entry is written into the freshly-emptied audit log itself, so there's
  a one-line record that a reset happened even though history before it
  is gone.

### Backup / restore
Export now also includes `gracePeriodDays`/`fineAmountPaisePerDay`, and
imported transactions carry their fine fields through (with safe
defaults for older backups that predate this feature — nothing is
rejected for missing them, per the existing backward-compatibility
policy).

### Versioning
`STACKROOM_APP_VERSION` → `3.0.0`, `STACKROOM_DB_VERSION` → `2` (an
additive Dexie schema bump — no index changes, so existing installs
upgrade with nothing to migrate), Service Worker `CACHE_VERSION` →
`stackroom-v5`.

### What I verified, and what I didn't
Per your instructions, I did not run the app or any tests. I did run
`node --check` over the extracted `<script>` block as a plain syntax
check (equivalent to a linter catching a missing brace/paren — not
executing any application logic), confirmed there are no duplicate
element IDs among everything I added, and confirmed HTML `<div>`/`</div>`
tag counts balance. I did not verify runtime behavior (e.g. actually
clicking through PIN entry, a return, a master reset) — please treat
the Master Reset flow in particular as the highest-priority thing to
click through yourself before trusting it on real data, precisely
because it's destructive and I could not exercise it.

---

## Previous round (v2, IndexedDB/Dexie edition)

This is the same Stackroom application you uploaded, with its persistence,
security, backup and offline architecture upgraded internally. **Nothing
about the UI, business rules, or existing feature set was intentionally
changed.** Every screen, button, workflow and visual design is the one you
already had — see "What changed" below for the parts that were necessarily
touched (storage engine and login security), and "Known limitations" for
an honest account of what this upgrade could *not* fully verify.

## Files

```
index.html      the app itself (HTML + CSS + JS, still one file)
sw.js           Service Worker — separate file, registered from index.html
manifest.json   PWA manifest
icon-192.png    PWA icon
icon-512.png    PWA icon
README.md       this file
```

Kept as one HTML file rather than split into `/assets/js/*.js`, per the
original brief's own fallback ("if maintaining a single file is more
appropriate, do not split unnecessarily") — the Service Worker still had
to be its own file, since a Service Worker cannot live inside the page
that registers it.

**To run it:** put all five files in the same folder and open
`index.html` (or serve the folder over `http://`/`https://` — Service
Workers require a real origin, so `file://` will register fine but the
browser may restrict the SW on `file://` in some browsers; a tiny local
static server, e.g. `npx serve` or Python's `python -m http.server`, is
the most reliable way to test PWA/offline behavior).

## What changed internally

### 1. Storage: localStorage/window.storage → IndexedDB via Dexie

The old app kept everything in two in-memory objects, `DB.books` and
`DB.transactions`, and every single CRUD operation (add/edit/delete a
book, issue, return, import) followed the same pattern: mutate the
array, then call `persistData()`. That pattern was **not changed** — the
UI and business logic still work exactly the same way.

What changed is what `persistData()` (and `persistSettings()`, and
`loadAll()`) actually *do* internally:

- `loadAll()` now opens a Dexie database (`StackroomLibraryDB`), runs the
  legacy-data migration (see below), and loads `books`/`transactions`
  into `DB.books`/`DB.transactions` from IndexedDB instead of a single
  JSON blob in `localStorage`.
- `persistData()` reconciles the in-memory `DB.books`/`DB.transactions`
  arrays into IndexedDB inside **one Dexie transaction**: current
  records are `bulkPut`, and anything that used to exist in the database
  but no longer exists in memory (e.g. a deleted book) is `bulkDelete`d.
  Because both tables are written in the same Dexie transaction, an
  issue or a return — which touches both a transaction record and a
  book's status, then calls `persistData()` once — is written to disk
  atomically: either both tables reflect the change or neither does.
- `persistSettings()` writes the settings object into a `settings`
  table (`{key:'app-settings', value: SETTINGS}`).

Dexie schema (`STACKROOM_DB_VERSION = 1`):

```js
{
  books:        '&id, barcode, title, author, class, subject, status',
  transactions: '&id, bookBarcode, bookId, studentId, status, issueDate, expectedReturnDate, returnDate',
  settings:     '&key',
  students:     '&studentId, name, class, section',
  auditLog:     '++id, timestamp, action, entity, entityId',
  meta:         '&key'
}
```

`books.id` and `transactions.id` are the primary keys (matching the
existing app's own `id` fields — no field renaming). `barcode` is
indexed but not enforced unique at the database level, deliberately, so
that migrating slightly-inconsistent legacy data can never throw a
constraint error and abort a migration.

The `students` store is populated automatically (from transaction
history) during migration and backup import — nothing about how the app
already derives "students" from transactions was touched; the store
just gives you an indexed table for anything that wants one later
(reports, exports) without asking anyone to retype rosters.

The `auditLog` store records book add/edit/delete, issue, return,
settings changes, PIN changes, and backup export/import. Writing to it
is wrapped in its own try/catch and is never allowed to fail the actual
library operation it's logging.

### 2. Legacy data migration (idempotent, non-destructive)

On first load after upgrading, `migrateLegacyDataIfNeeded()`:

1. Checks `meta.migrationVersion` — if present, does nothing (already
   migrated or already a fresh install that was checked once).
2. If IndexedDB already has books/transactions (e.g. a previous
   migration attempt got interrupted after writing data but before the
   marker), it does **not** overwrite them — it just marks migration
   complete and stops.
3. Otherwise it reads whatever the old version saved, via either the
   Artifacts `window.storage` host API or the `localStorage` fallback
   (both read-only now — see `legacyStorageAdapter`), validates every
   record with the app's own existing `isValidBookRecord`/
   `isValidTxRecord` functions, and imports the valid ones into
   IndexedDB inside one Dexie transaction, along with settings and a
   students list backfilled from the transaction history.
4. Only after that transaction succeeds does it write the
   `migrationVersion` marker.

**Nothing ever deletes the original `localStorage` data.** If migration
fails for any reason, the marker is not written, the legacy data is
untouched, and the app will safely retry on the next page load.

### 3. Login security

The previous "PIN" was computed from the current 24-hour clock time
(`HHMM`) — the correct PIN was always just whatever time it currently
was, which is not a secret and never was real authentication.

This has been replaced with an admin-chosen 4-digit PIN, verified
locally with **PBKDF2-SHA256 (150,000 iterations)** — the PIN itself is
never stored, only its salted hash, in the `meta` table. On first run
(or after upgrading from a version with no stored verifier), the login
screen asks the admin to choose and confirm a new PIN instead of
comparing against the old clock-derived value. There's also a "Change
Admin PIN" button in Settings → Security.

Brute-force protection: after 5 wrong attempts, a lockout kicks in
(30s, doubling per additional failure, capped at 5 minutes), tracked in
the `meta` table so it survives a page reload. It is never a permanent
lockout.

**Known limitation, stated plainly:** the login UI is still a 4-digit
numeric keypad (kept for UX continuity with the existing design). A
PBKDF2 hash of a 4-digit PIN is much better than a hash of a full
password, but a 4-digit space is small — the real protection here is
the lockout, not the hash strength. If you want stronger local auth,
the natural extension is raising `pinBuffer.length>=4` to a longer
value and adjusting the keypad; that wasn't done here to avoid an
unrequested UI redesign.

### 4. Encrypted backup

The existing AES-256-GCM + PBKDF2-SHA256 backup format, and its
modal/UI, are unchanged. What changed:

- Export now reads directly from IndexedDB (not just whatever happens
  to be in memory) and includes `students`, the last 500 `auditLog`
  entries, and `schemaVersion`/`dbVersion`/`appVersion` metadata.
- Import still validates every incoming record with the existing
  `isValidBookRecord`/`isValidTxRecord` functions, still rejects
  duplicates, still goes through `persistData()`'s single-transaction
  write — so a decrypted-but-partially-invalid file can't leave
  IndexedDB half-updated.
- Student records from the backup are merged in as a best-effort,
  non-blocking step after the book/transaction import completes.

### 5. Service Worker & offline

`sw.js` is registered from `index.html` on load. Strategy:

- **App shell** (`index.html`, `manifest.json`, the two icons):
  cache-first, so the app itself launches offline after having been
  opened at least once.
- **Third-party CDN libraries** (Dexie, html5-qrcode, qrcode-generator,
  JsBarcode, jspdf, xlsx, Google Fonts): **stale-while-revalidate** —
  served instantly from cache if present, with a background fetch
  refreshing the cached copy whenever the network is available.

**Known limitation, stated plainly:** the CDN libraries are *not*
vendored into local files. I did not have network access in the
environment I built this in to reliably download and verify multi-file
libraries like `xlsx.full.min.js` or `html5-qrcode.min.js` byte-for-byte,
and shipping a hand-copied or partially-verified library would be worse
than being explicit about this. The practical effect: **the very first
load of the app needs an internet connection** (to fetch and cache
Dexie and the other CDN scripts); every load after that — including
fully offline ones — works from cache, because the Service Worker keeps
them cached indefinitely (refreshing in the background whenever online).
If you want true zero-network-ever offline support, download the six
CDN files listed in the original spec into an `/assets/js/` folder,
point the `<script src>` tags in `index.html` and the `RUNTIME_HOSTS`
check in `sw.js` at the local copies, and the rest of the caching logic
needs no other changes.

### 6. PWA

`manifest.json` declares name, icons, `theme_color`/`background_color`
matching the existing clay/parchment palette, and `display: standalone`.
Two icons were generated (192px/512px) using the app's existing accent
color and an open-book glyph in the same stroke style as the in-app
icons — nothing about the existing visual identity was changed.

### 7. Secure admin PIN recovery (new)

A locally-generated **recovery code** lets the admin reset a forgotten
PIN without a server, without any master/backdoor code, and without
touching library data. It's a second, independent authentication
mechanism layered on top of the existing PIN — nothing about the PIN
login flow itself changed except the addition of a "Forgot PIN?" link.

**Generation & format.** `generateRecoveryCode()` builds a
`XXXX-XXXX-XXXX-XXXX` code entirely from `crypto.getRandomValues()`
over a 32-character alphabet that excludes visually-ambiguous
characters (`0/O`, `1/I/L`), giving ~80 bits of entropy. It is never
derived from the PIN, a timestamp, the school name, student data,
device info, or a counter, and never uses `Math.random()`.

**Storage.** The plaintext code is never written anywhere. Only a
PBKDF2-SHA256 verifier (150,000 iterations, its own random salt —
never the PIN's salt) is stored, in a new `meta` row keyed
`recoveryVerifier`, structurally identical in spirit to the existing
`authVerifier` row but completely separate:

```js
{ key:'recoveryVerifier', saltB64, iterations, hashB64, kdf:'PBKDF2-SHA256', version:1, createdAt }
```

**Setup / regeneration.** From Settings → Security, "Set Up Recovery
Code" (or "Regenerate Recovery Code" once one exists) first opens a
Confirm Admin PIN modal — regeneration is never allowed just because
the app is already open. On success, `initializeRecoveryCode()`
generates a fresh code + fresh salt and atomically replaces the
`recoveryVerifier` row in one Dexie transaction (old verifier and old
code are invalidated in the same write), then shows the code exactly
once in a modal that has no close button and requires an "I have
securely recorded my recovery code" checkbox before it can be
dismissed. The code is held only in a short-lived local variable
(`pendingRecoveryCode`) for the life of that modal and is cleared —
and the DOM text reset to placeholder dots — the instant it closes.

**Recovery flow.** "Forgot PIN?" on the login screen (visible only
once a PIN actually exists to recover) opens a two-stage modal: enter
the recovery code → `verifyRecoveryCode()` normalizes formatting
(case/spaces/hyphens only — never fuzzy-matches actual characters),
re-derives a verifier with the stored salt/iterations, and compares it
to the stored hash with `secureEqualBytes()`, a constant-time
byte-array comparison with no early exit. A correct code unlocks a
"choose a new 4-digit PIN" step; `resetPinWithRecovery()` then calls
the existing, unmodified `setAuthPin()` — which touches only the
`authVerifier` row — and nothing else. Books, transactions, students,
settings, and audit history are never read or written by this path.

**Rate limiting.** Recovery attempts have their own lockout, tracked in
`meta` rows separate from the PIN's own lockout (`recoveryFailCount`/
`recoveryLockUntil`): 5 wrong attempts → 30s, doubling per additional
failure, capped at 5 minutes, surviving reloads, never permanent. A
wrong code always shows the same generic "could not be verified"
message — it never reveals whether a recovery code exists, or any
stored salt/hash/iteration detail.

**Audit trail.** `recovery_code_initialized` / `recovery_code_regenerated`
/ `pin_reset_via_recovery` events are written through the existing
`writeAuditLog()` — same table, same non-fatal try/catch behavior as
every other audit event. None of these entries ever contain the
recovery code, the PIN, or any derived secret — only the action name,
entity, and a short human-readable description.

**Backup isolation.** `encryptBackupPayload()` was not changed and
still reads only `books`/`transactions`/`students`/`auditLog` — it
never reads the `meta` table at all, so the recovery verifier, salt,
and lockout state can never end up in an exported backup, encrypted or
otherwise.

**Service Worker isolation.** `sw.js` only ever intercepts `GET`
requests for the app shell and the CDN runtime hosts (see below) — it
has no knowledge of IndexedDB or of any recovery data, so there is
nothing new to isolate there beyond the existing cache-version bump.

### 8. One student, one active book (new business rule)

`activeIssueForStudent(studentId)` looks up any transaction with
`status==='issued'` whose (trimmed, case-normalized) `studentId`
matches — identity is always the Student ID, never the name, so two
students who happen to share a name are never conflated, and a
student's own ID is never rewritten. Returned/historical transactions
never count and are never touched or deleted.

The rule is enforced at **two** points, matching requirement 31 (never
rely on the UI alone):
1. An early warning when moving from student details to the book scan
   step ("Continue to book scan").
2. The **mandatory, final** re-check inside the `issueConfirmBtn`
   handler, immediately before the transaction object is built and
   pushed — this is what actually prevents a second active loan, even
   if the first check passed and something changed in between (another
   tab, a duplicate click, etc). This re-check reads the same
   `DB.transactions` snapshot that the existing atomic `persistData()`
   Dexie write already commits from, so no new race window is
   introduced.

### 9. QR camera scanner reliability fix

Root cause: the previous camera scan configuration used a **fixed
pixel `qrbox`** (`{width:220, height:130}`). `html5-qrcode` can't scan
a region larger than the actual rendered video — on any phone or
container narrower than ~220px (common in this app's own fluid
`width:100%` scanner frame, especially in portrait mobile layouts),
the requested scan box didn't fit inside the video and detection
silently failed or never engaged.

Fix: `qrbox` is now a function that sizes the scan region as a
percentage of whichever viewfinder dimension is smaller, so it always
fits inside the actual video regardless of screen size or orientation.
Alongside that:

- `formatsToSupport` is restricted to `Html5QrcodeSupportedFormats.QR_CODE`
  (camera path and image-upload path) — this app only ever
  generates/expects QR codes via scanning, and narrowing the format
  search space also reduces per-frame decode work.
- A `scanProcessed` guard ignores any decode callback after the first
  one in a given scan session, so a QR code still in frame while
  `stop()` is asynchronously tearing down the camera can never fire
  the issue/return/add-book workflow twice from one physical scan.
- A `scannerStarting` guard prevents a second `start()` from
  overlapping a first one still in flight (e.g. a fast double-tap on
  "Start Camera"), which could previously race two `Html5Qrcode`
  instances against the same camera/DOM node.
- Manual barcode entry, QR image upload, QR generation (single and
  bulk), and every existing scanner-toggle/placeholder/cleanup call
  site are unchanged.

### 10. Recovery-code input bug fix (root cause)

The "Forgot PIN?" flow was opening a modal that was effectively
unusable. Root cause was two separate bugs stacked on top of each
other, both now fixed:

1. **Z-index stacking.** `#loginScreen` (the full-screen login card) has
   `z-index:500`; the shared `.modal-overlay` class used by every modal
   in the app has `z-index:200`. Any modal opened while the login
   screen is still showing — which is exactly when "Forgot PIN?" opens
   its modal — rendered **behind** the opaque login screen and was
   invisible and unclickable. Fixed with a two-selector CSS override
   (`#recoveryModalOverlay, #recoveryCodeModalOverlay{ z-index:600; }`)
   that raises only these two modals above the login screen, without
   touching the shared `.modal-overlay` stacking used everywhere else.
2. **Keyboard capture.** A global `keydown` listener feeds every digit
   key into the PIN keypad's buffer whenever the login screen is
   visible — including while a modal is open on top of it. Typing a
   recovery code (which contains digits) was silently also driving the
   hidden PIN buffer, and reaching 4 digits there could trigger a
   background PIN-verification attempt. Fixed by having that listener
   bail out whenever any `.modal-overlay.open` exists in the document.

With both fixed, the recovery-code `<input type="text">` — which
already had correct `autocomplete`, `autocapitalize`, `spellcheck`,
focus-on-open, Enter-to-submit, and clear-on-close behavior from the
previous update — is now actually visible, focused, and fully usable.

### 11. Recovery code setup — first-time-only

Previously, recovery-code setup was never shown automatically at all
(only reachable via Settings → Security). It's now triggered exactly
once, immediately after the very first admin PIN is created
(`loginMode==='setup-confirm'` success path) — and only there. Logging
out and back in, refreshing the page, or any later login never
triggers it again; Settings → Security continues to show "Set Up
Recovery Code" for a pre-existing install that has a PIN but no
recovery code yet (e.g. one upgraded from before recovery codes
existed), and "Regenerate Recovery Code" once one is configured — both
still gated by current-PIN reauthentication, unchanged from before.

### 12. Exactly one beep per successful scan (Web Audio API)

A single shared `AudioContext` (lazily created/resumed from the same
tap that starts a scanner, to satisfy the browser's user-gesture
requirement) drives `playScanBeep()` — a short synthesized sine-wave
blip, no audio file or external dependency. It is called from each
scanner call site's own **accept** branch — i.e. only after the
decoded payload has actually been validated as usable (a real book
found for Issue/Return, a well-formed Book/Student QR for Add Book) —
never from the raw camera-decode callback. That placement matters: an
invalid QR, a QR of the wrong type (see below), or a duplicate callback
for a QR still sitting in front of the camera never produces a beep,
only a genuinely-accepted scan does. Manual barcode typing never
beeps, only actual scans (camera or image-upload) do.

### 13. Wrong-QR-type guards (Book vs Student)

A new `detectQrPayloadType(text)` classifier (separate from, and never
altering, the existing `parseScannedPayload()` used to actually read a
Book QR) distinguishes a Student QR (`{"type":"student",...}`) from a
Book QR (has `.barcode`) from a plain non-JSON barcode string. Every
Book-QR scanner (Add Book, Issue, Return — camera and image-upload
paths) now rejects a scanned Student QR with "Please scan a Book QR
Code." without touching the form's existing fields, and the new
Student QR scanner (see below) rejects a scanned Book QR the same way
with "Please scan a Student QR Code." On a wrong-type rejection the
camera scanner is explicitly kept running (the internal `scanProcessed`
guard is reset) so the admin can immediately rescan the right code
without restarting the camera.

### 14. Multiple-book special permission (per-student, Admin-controlled)

The one-student-one-active-book rule from the previous update is now
**conditional** rather than absolute. A new `allowMultipleBooks`
boolean lives directly on the existing `students` table record (no
second database, no Dexie schema/version bump — IndexedDB stores don't
require every property to be declared as an index, only ones actually
queried by, and `studentId` already is the primary key) and defaults to
`false`/absent for every existing and new student.

- `studentAllowsMultipleBooks(studentId)` / `setStudentMultiBookPermission(studentId, allow)`
  read and upsert just that flag, preserving whatever name/class/
  section already exists on the record.
- A checkbox in Issue Book Stage 1 ("Allow Multiple Books") reflects and
  toggles the current student's permission live, persists immediately,
  and is audit-logged (`student_multi_book_enabled` /
  `student_multi_book_disabled`) — never the PIN, never any secret.
- Both enforcement points from the previous update — the early warning
  at "Continue to book scan" and the **mandatory, final** re-check
  inside `issueConfirmBtn` immediately before the transaction is
  created — now check `studentAllowsMultipleBooks()` first and skip the
  one-book block entirely when it's true. The final check re-reads the
  permission from the database itself (not the Stage-1 checkbox's
  in-memory state), so it can't go stale between steps.
- Disabling the permission later never touches existing transactions —
  it only affects whether a *new* additional loan is blocked; a
  student's existing multiple active loans remain valid and returning
  any of them still works normally. This is inherent to the design
  (the check only ever runs at new-issue time) rather than a separate
  code path that needed to "preserve" anything.

### 15. Scan Student QR during Issue Book

Issue Book Stage 1 now has a Manual Entry / Scan Student QR toggle
(scoped to its own `#issueStudentIdToggle` container — see the code
comment there about why it couldn't reuse the existing generic
`.scanner-toggle button` selector without colliding with the unrelated
Camera/Manual toggle used later for the Book QR scan in Stage 2).
Scanning a Student QR auto-populates Student ID, Name, and Class/
Section, shows a clear success state, and lets the admin continue
straight to the book scan — manual entry remains fully available and
unchanged. The student's multiple-book-permission checkbox is refreshed
immediately after a successful scan, same as after manually typing/
blurring the Student ID field.

### 16. Student Bulk QR Code generation

The Bulk QR view gained a Book Information / Student Information
sub-tab (`#bulkQrTypeToggle`) sitting above the existing (untouched)
Book Bulk QR Generator panel. The Student panel is a parallel,
independent implementation that deliberately mirrors the Book
generator's architecture rather than sharing mutable state with it:

- **Template & sample download** — `Download Sample Student Excel`
  produces a real `.xlsx` (via the same `XLSX` library already used for
  the Book sample) with the exact required headers (`Student ID / Roll
  Number`, `Student Name`, `Class / Section`) and 5 realistic sample
  rows. The existing Book sample download is untouched and both remain
  available side by side.
- **Import & validation** — header matching tolerates case, extra
  whitespace, and common header variants (`normalizeStudentHeaderKey`);
  Student ID, Name, and Class/Section are all required, blank rows are
  silently skipped, and any other invalid/duplicate-within-file row is
  marked invalid with a specific reason shown in a per-row preview list
  — one bad row never stops the rest of the file from processing.
- **QR payload** — `{"type":"student","version":1,"studentId":...,
  "studentName":...,"class":...,"section":""}`. `section` is always
  emitted empty and the whole "Class / Section" cell goes into `class`
  unchanged: this app's live Issue Book form (`issueStudentClass`) has
  always treated class/section as one combined field, so that's the
  data model this preserves rather than guessing a split that could
  misparse real values.
- **PDF layout** — identical A4, 5×5, ≤25-per-page grid math, dotted
  cutting-line cell borders, and the same `drawScissors()` cutting-mark
  helper as the existing Book Bulk QR PDF; nothing about the Book
  layout was changed to build this.
- Like the Book generator, this **only produces a printable PDF** — it
  does not write anything into the `students` table, matching the
  existing Book generator's behavior of never writing into `DB.books`
  either. Generation is audit-logged
  (`student_bulk_qr_generated`, count + page count only).

### 17. Multiple encrypted backup import — merge, not restore

The import file picker now accepts multiple files at once
(`<input ... multiple>`) and the entire import path was rewritten
around a shared `mergeSingleBackupPayload()` merge function instead of
the previous single-file `runImport()`:

- Each selected file is read and JSON/wrapper-checked independently;
  files that aren't valid JSON or aren't a recognizable encrypted
  Stackroom backup are recorded as failed immediately and never block
  the rest of the batch.
- **One password prompt covers the whole batch** (the common case for
  "select several backups at once" is the same admin, same password);
  a file that fails to decrypt with it — wrong password, corrupted,
  tampered — is recorded as a failed file with a generic reason and the
  rest of the batch still proceeds. No error message ever includes the
  password, a derived key, a hash, or a salt.
- Every book/transaction/**student** record from every successfully-
  decrypted file is validated (`isValidBookRecord` / `isValidTxRecord` /
  new `isValidStudentRecord`) and deduplicated by its real identifier
  (barcode+ID for books, transaction ID, Student ID) against both the
  **current live database** and every other file already merged in the
  same batch — never a naive string/object comparison. A duplicate is
  skipped, never overwritten; an invalid or blank record is skipped;
  neither ever aborts the rest of the file or the batch.
- Student records imported this way get `allowMultipleBooks` defaulted
  to `false` when the field is absent from an older backup — backward
  compatible, never rejects an otherwise-valid legacy backup over a
  field it predates.
- The actual database write is still a **single** atomic step
  regardless of how many files were merged: all books/transactions
  across the whole batch are folded into the in-memory `DB.books` /
  `DB.transactions` arrays first, then written once via the existing
  `persistData()` (one Dexie `'rw'` transaction), with one
  `students.bulkPut()` for every newly-accepted student and one
  consolidated `backup_imported` audit-log entry for the whole batch.
- A detailed report renders after every import: total files, files
  succeeded/failed (with reasons), records added by type, and a
  scrollable **File / Type / ID / Reason** table listing every skipped
  or failed record/file — nothing sensitive (no password, key, hash,
  or salt) ever appears in it.

### 18. Refresh-safe login session (new)

Previously, refreshing the browser after a successful login always
dropped back to the PIN screen — there was no session concept at all.
This adds one, without persisting anything that could be reused as a
credential.

**Mechanism.** On a successful login (fresh PIN entry, or PIN creation
during first-time setup), `startAuthenticatedSession()` generates a
random 16-byte token via `crypto.getRandomValues()` — never derived
from the PIN, the recovery code, a hash of either, or any timestamp —
and writes it to two places: `sessionStorage` (browser-tab-scoped;
cleared automatically the moment the tab or window actually closes,
never survives a real restart) and a new `meta` row keyed
`activeSessionToken` (the same table `authVerifier`/lockout state
already live in). On page load, `hasValidSession()` restores the
logged-in view directly — skipping the PIN screen — **only if both
copies exist and match exactly**; if either is missing (a real browser
restart, a different tab, a cleared token) the normal PIN login screen
shows as before.

**Invalidation.** Both copies are cleared together by
`endAuthenticatedSession()`, called from Sign Out, Change Admin PIN,
PIN reset via recovery code, and Master Reset (see below) — so a
session token from before any of those actions can never be replayed
afterward.

**What is never stored, anywhere, for this feature:** the PIN, the
recovery code, a hash of either, an encrypted or encoded form of
either, or a boolean flag standing in for "is logged in" with no
verifiable state behind it. The session token itself grants no way to
reconstruct the PIN or recovery code, since it isn't derived from
either in the first place.

### 19. Master Reset (new)

A new "Danger Zone" panel in Settings → Security, below the existing
PIN-recovery panel, using the same `.btn-danger` style already defined
in the stylesheet (previously unused).

**Confirmation gate — two steps, neither skippable:**
1. A plain warning `confirm()` (same convention as the existing
   "Change Admin PIN" button) stating the action is destructive and
   irreversible.
2. The existing `pinConfirmModal` reauthentication gate — the same
   modal and the same `verifyAuthPin()` PBKDF2 check already used
   before recovery-code setup/regeneration. No separate password or PIN
   is created for Master Reset, and an incorrect PIN leaves every table
   untouched and shows the modal's existing inline error.

**What gets reset.** `performMasterReset()` clears every table this
app owns — `books`, `transactions`, `settings`, `students`,
`auditLog`, and `meta` (which is where the PIN verifier, recovery
verifier, and lockout counters all live) — inside a single Dexie
transaction, then writes a fresh `migrationVersion` marker in that same
transaction so a stale copy of this app's own pre-Dexie
`localStorage`/`window.storage` fallback data can never repopulate the
freshly-emptied database on the next load. The app's own two
namespaced legacy `localStorage` keys (`stackroom:shared:library-data`,
`stackroom:local:app-settings`) are removed directly for the same
reason; nothing outside those two keys, and nothing belonging to any
other site or browser feature, is touched. The page then reloads,
landing back on first-time PIN setup — exactly like a fresh install.

### 20. Service Worker cache bump — the actual reason a fix "only works in Incognito"

This wasn't a new bug — it's an explanation, worth recording, for a
symptom that can recur with *any* future fix to this app if the same
step is forgotten. `sw.js` serves the app shell (`index.html`
included) **cache-first**: once a browser has opened this app even
once, every later visit is served the cached copy first, network
second. A page that already had a cached shell from before a bug was
fixed keeps seeing the *old, buggy* `index.html` until
`CACHE_VERSION` changes — the `activate` handler only deletes prior
caches when the version string itself is different. Incognito/Private
windows never had a prior visit to cache anything from, so they always
fetch the current file fresh — which is exactly why the same
already-fixed code behaves differently between the two modes; it's a
caching artifact, not a logic difference. `CACHE_VERSION` is bumped
every time `index.html` changes (see "Database & migration versions"
below) specifically so this can't happen silently again.

## Database & migration versions

- `STACKROOM_DB_VERSION = 1` (Dexie schema version — **unchanged**; no
  schema migration was required for this update either, since
  `allowMultipleBooks` is stored as a plain unindexed property on the
  existing `students` table record, exactly like `recoveryVerifier`
  before it lived as a plain record in the existing `meta` store, and
  the new `activeSessionToken` meta row follows the same pattern)
- `STACKROOM_APP_VERSION = '2.3.0'` (bumped — Master Reset,
  refresh-safe login session, Service Worker cache bump; no destructive
  migration involved in any of it)
- `STACKROOM_SCHEMA_VERSION = 2` (unchanged — this is the existing
  *backup file* schema version, not the database version; Master Reset
  and the session token don't touch backup import/export at all)

To add a future schema change: add `libraryDB.version(2).stores({...})`
below the existing `version(1)` block (Dexie migrates automatically),
and bump `STACKROOM_DB_VERSION`. To ship a new Service Worker cache
set, bump `CACHE_VERSION` at the top of `sw.js` — the `activate` handler
deletes any cache from a previous version automatically.
`CACHE_VERSION` was bumped to `stackroom-v4` in this update (from
`stackroom-v3`) so that clients pick up all of the above instead of
serving a stale cached `index.html` — see "Service Worker cache bump"
above for why skipping this step is exactly what makes a fix look like
it "only works in Incognito."

## Verification report

**This update includes a real-browser test pass** (see below) — the
previous limitation ("no live browser in this environment") has been
partially lifted: a local Chromium binary and Playwright were
available, so this round was verified by actually running the app,
not just by static code review.

### Real-browser testing performed

**Environment constraint:** this sandbox has no outbound network
access at all — not from the browser, not from `npm`/`pip` — so the
app's real CDN dependencies (Dexie, html5-qrcode, qrcode-generator,
JsBarcode, jsPDF, XLSX) could not be loaded from their real CDN URLs.
To still get genuine functional coverage rather than skip live testing
entirely, a **local Dexie-compatible shim backed by real native
IndexedDB** was built (not a mock — actual IndexedDB reads/writes,
implementing exactly the subset of Dexie's API this app calls), plus
lightweight stubs for the QR/PDF/Excel libraries (real Canvas API for
QR image generation, real page-count math for jsPDF, a self-consistent
in-memory workbook for XLSX). AES-GCM/PBKDF2 backup encryption needed
no stub at all — `crypto.subtle` is a native browser API. These test
harnesses are **not part of the delivered app** — only used locally to
drive `index.html` in a real browser for this verification pass.

Four independent Playwright test suites were run against real
Chromium, driving the actual UI (clicks, typing, keyboard events,
screenshots, computed-style/z-index/hit-testing checks) — **83 of 83
checks passed**, with one caveat below on Bulk QR file parsing:

- **Recovery-code system (36/36)** — this is the actual bug reported.
  First-time PIN setup → recovery code auto-shown once, gated by the
  confirmation checkbox → does **not** reappear after logout/login →
  "Forgot PIN?" now opens a modal confirmed via real computed z-index
  (600, beating the login screen's 500), real hit-testing (the input
  is the actual topmost element at its own coordinates, not covered),
  and real auto-focus → typed digits land in the recovery field and
  verifiably do **not** leak into the hidden PIN dots (the exact
  keyboard-capture bug) → full reset-PIN-via-recovery round trip (old
  PIN rejected, new PIN works) → repeated wrong codes trigger lockout →
  full regeneration round trip (old code rejected, new code accepted).
- **Books, Issue/Return, one-book rule, multi-book permission (18/18)**
  — added books, issued a book via manual barcode entry, confirmed the
  one-student-one-book rule blocks a second loan with the right
  message, enabled "Allow Multiple Books" and confirmed a second loan
  now succeeds, confirmed the active-loan-count label updates, returned
  a book, disabled the permission afterward and confirmed the
  **existing** second loan is untouched while a new third loan is
  correctly blocked, and confirmed two students sharing a name but not
  an ID are never conflated.
- **Wrong-QR-type guards, Student QR scan, multi-file backup merge
  (18/18)** — simulated camera decodes (via a test-only hook standing
  in for real camera hardware, which no automated environment can
  exercise) confirmed a Student QR is rejected with "Please scan a
  Book QR Code." without corrupting the form, that the camera keeps
  running for an immediate correct rescan, and the reverse case for the
  Student scanner. Then: exported a real encrypted backup (genuine
  AES-GCM/PBKDF2 via `crypto.subtle`, genuine file download via
  `expect_download`), added more data, exported a second (superset)
  backup, deliberately corrupted a third fake file, and imported all
  three at once — confirmed the report shows 2 of 3 files succeeded,
  the corrupted file is listed as failed by name, overlapping records
  between the two real backups were correctly deduplicated (each book
  appears exactly once after merge, not doubled), and no password/salt/
  hash ever appears in the report text.
- **Bulk QR UI + mobile responsiveness (11/11)** — Book/Student
  sub-tab switching works and doesn't disturb the other panel, both
  sample-download buttons run without throwing, the Generate PDF
  buttons stay correctly disabled with no data loaded, no horizontal
  overflow at a 375px mobile viewport (dashboard and with the recovery
  modal open), and the hamburger menu correctly reaches the sidebar's
  Logout button on mobile.

**What this real-browser pass could NOT cover, and why:**
- Actual QR camera scanning (real hardware — no automated environment,
  headless or otherwise, can exercise a real camera; the wrong-type-
  guard and populate-fields logic downstream of a decode WAS verified,
  via simulating what a real decode callback delivers).
- Real `.xlsx` binary parsing for Student/Book Bulk QR uploads — the
  XLSX stub used here doesn't implement real spreadsheet binary
  format, so the upload→parse path itself wasn't exercised end-to-end
  this round (the tab-switching, sample-download, and disabled-until-
  data-loaded UI states were verified instead). The row-validation
  logic itself (header alias matching, required-field checks,
  duplicate-in-file detection) was verified by static code review, not
  by running it against a real file.
- Real PDF visual rendering (the jsPDF stub tracks page-count math for
  real but doesn't rasterize actual PDF bytes).
- Installability/PWA behavior and the Service Worker's actual offline
  cache-first behavior (both need a real hosted origin+manifest
  install prompt, not just a local static file server).

**One real bug was suspected, investigated, and ruled out:** during
this pass, Issue Book's confirm step initially appeared to hang. Deep
investigation (screenshots, polling the DOM every 100ms, an explicit
`unhandledrejection` listener) traced it conclusively to the **test
script**, not the app: Playwright's `.fill()` already fires a native
`change` event, and the test was *also* manually dispatching a second
`change` event right after — double-triggering the barcode handler's
scheduled UI transition, so a second, stale transition would fire
*after* the test had already clicked "Issue Book" and moved on,
re-hiding the reset form. Removing the redundant trigger fixed it
immediately, and the full flow — including the exact same one-book and
multi-book-permission scenarios — passed cleanly afterward. No
application code changed as a result of this investigation.

### Previously statically verified (still holds)



- The full inline script parses successfully under Node's JS parser
  (`node --check`) after every edit in this session, including the
  final combined state with all of: the recovery-modal bug fix, the
  first-time-only recovery setup, the scan beep, the wrong-QR-type
  guards, the multiple-book permission, Student Bulk QR, and the
  multi-file backup merge.
- Every function name in the file — existing and newly added this
  session (`playScanBeep`, `ensureAudioCtx`, `detectQrPayloadType`,
  `activeIssuesForStudent`, `getStudentRecord`,
  `studentAllowsMultipleBooks`, `setStudentMultiBookPermission`,
  `refreshMultiBookToggleForStudent`, `processStudentBulkRows`,
  `renderStudentBulkPreview`, `normalizeStudentHeaderKey`,
  `readFileAsText`, `mergeSingleBackupPayload`, `isValidStudentRecord`,
  `renderImportReport`, plus every modal-wiring function from the
  previous session) — is unique within the app's IIFE scope; no
  accidental redeclaration.
- Every `document.getElementById('literal-id')` call in the file
  (289 total after this session's additions) targets an id that
  actually exists in the markup — verified by script, zero missing.
- No duplicate `id="..."` attributes anywhere in the file.
- HTML tag balance (`<div>`/`</div>`, `<script>`/`</script>`) is even
  after every edit this session (346/346 divs, 7/7 scripts, at the
  final state).
- Source-audited again for secret exposure: every `console.error` call
  in the file (13 total) logs only a caught exception object, never a
  PIN, recovery code, verifier, salt, or backup password; every backup
  import failure message (bad JSON, wrong wrapper, wrong password,
  tampered file) is a fixed generic string, never derived from the
  actual cryptographic failure detail.
- Every function referenced by the new Student Bulk QR / multi-backup
  code (`qrToPngDataUrl`, `drawScissors`, `bookCopies`, `todayISO`,
  `hasWebCrypto`, `isEncryptedBackupWrapper`, `validateBarcodeFormat`,
  `findBookByBarcode`, `availableCopiesFor`, `syncBookAutoStatus`,
  `persistData`, `writeAuditLog`, `escapeHtml`, `showToast`) was
  confirmed to actually exist in the file before being called, by
  scripted occurrence-count check.
- Caught and fixed one real scoping bug during this session's own
  review, before it ever shipped: the new Student-ID Manual/Scan-QR
  toggle initially reused the same `.scanner-toggle button` CSS class
  as the pre-existing Book-QR Camera/Manual toggle in Issue Stage 2.
  Since the wiring code originally selected by that shared class name
  document-wide within `#view-issue`, the two toggles would have
  fought over each other's click handling. Fixed by giving each its
  own id (`#issueStudentIdToggle`, `#issueBookScanToggle`) and scoping
  every listener to it.

**Not run end-to-end in a real browser** — same limitation as before:
no headless browser with the CDN scripts (Dexie, html5-qrcode, XLSX,
jsPDF) loading successfully in this sandboxed environment. Every item
below has been carefully traced through the code but not exercised
live. Please walk through, in addition to the previous session's
checklist:

- Open the app fresh, confirm "Forgot PIN?" now actually opens a
  visible, focused, typeable Recovery Code field on top of the login
  screen (this was the actual bug reported) — type a code with digits
  in it and confirm the background PIN dots never light up.
- First-time setup on a brand-new install: confirm the recovery-code
  display modal appears automatically right after PIN creation, then
  log out and back in and confirm it does **not** appear again.
- Issue a book to a student, confirm the "Allow Multiple Books"
  checkbox is disabled until a Student ID is entered, then toggle it on
  and confirm a second book can now be issued to the same student;
  toggle it back off and confirm a *third* book is blocked while the
  first two remain listed as active loans.
- In Issue Book, switch to "Scan Student QR", scan a Student QR
  generated by the new Student Bulk QR tool, and confirm the three
  fields populate and the multi-book checkbox reflects that student's
  actual saved permission.
- Try scanning a Book QR where a Student QR is expected (and vice
  versa) and confirm the "Please scan a ___ QR Code" message appears
  with no beep and no field corruption, and that the camera keeps
  running for an immediate retry.
- Confirm exactly one beep per successful scan across Add Book, Issue,
  Return, and the new Student scanner — and no beep at all for an
  invalid or wrong-type QR, or for manual barcode typing.
- Bulk-generate Student QR codes for 26 and for 51 sample students and
  confirm 2 and 3 PDF pages respectively, with scissors marks matching
  the existing Book QR PDF's style.
- Export two backups from two different points in time (so they share
  some records and each has some new ones), then select **both** files
  at once in Import and confirm: the report shows both files
  succeeded, only the genuinely-new records were added, every
  already-existing/duplicate record is listed in the skipped table with
  a correct reason, and no existing data was altered. Then try adding a
  third, deliberately corrupted file to the same selection and confirm
  it's reported as a failed file while the other two still import.

Please treat anything unexpected in that pass as a bug report I'd want
to fix rather than an acceptable gap.

- Existing features preserved: **yes, by construction** — every change
  this session was either a new function/modal/panel, or a small
  targeted edit at a specific existing call site (the two scanner
  functions' decode paths, `issueToStep2`/`issueConfirmBtn`, the single
  import handler which was replaced by a functionally-equivalent-plus-
  multi-file version). No unrelated existing function was rewritten,
  renamed, or had its prior behavior removed; the Book Bulk QR
  Generator, Book sample Excel download, and Book QR PDF layout are
  byte-for-byte the same code paths as before this session.
- Recovery-code input bug: root-caused (modal z-index + keyboard
  capture) and fixed — not live-tested.
- Recovery-code first-time-only setup: implemented — not live-tested.
- Scan beep: implemented (Web Audio, one shared `AudioContext`) — not
  live-tested; this is inherently hard to verify statically since it
  depends on real browser audio permission/gesture behavior.
- Wrong-QR-type guards: implemented for every Book/Student scanner
  pair — not live-tested.
- Multiple-book permission: implemented, including the disable-doesn't-
  touch-existing-loans guarantee (inherent to the design, not a
  separate code path) — not live-tested.
- Student Bulk QR (Excel template, sample download, validation, PDF
  with scissors marks): implemented, mirroring the existing Book
  generator's architecture exactly — not live-tested; PDF generation
  in particular needs a real browser to confirm the visual layout.
- Multi-file encrypted backup import/merge: implemented with per-file
  isolation, real-identifier deduplication against both the live
  database and the rest of the batch, and a detailed skip/failure
  report — not live-tested; this is the piece I'd most want a real
  round-trip test on, since it's the most structurally complex change
  in this session.
- Database version: 1 (unchanged — `allowMultipleBooks` needed no
  schema migration, same as recovery metadata before it).
- Known limitations carried over: 4-digit PIN keyspace (mitigated by
  lockout); CDN libraries not vendored (mitigated by SW caching after
  first load); no live browser test was performed this session either,
  for any of the 17 documented changes above.

### This session (Master Reset, refresh-safe session, cache bump) — code-level verification only, by explicit request

No manual/end-to-end/live-browser testing was performed this session —
it was explicitly requested that only code-level verification be done.
What was checked:

- The full inline script (extracted from `index.html`) parses
  successfully under Node's JS parser (`node --check`) after every edit.
- No duplicate `id="..."` attributes anywhere in the file, including
  the three new ones added this session (`masterResetBtn` and the new
  "Danger Zone" panel's markup).
- HTML tag balance (`<div>`/`</div>`, `<script>`/`</script>`) is even at
  the final state.
- Every new function (`generateSessionToken`, `startAuthenticatedSession`,
  `endAuthenticatedSession`, `hasValidSession`, `performMasterReset`) is
  called only after its declaration and referenced under the name it was
  declared with — no undefined-function calls introduced.
- `enterApp()` was changed from a sync to an async function (it now
  awaits `startAuthenticatedSession()`); both of its call sites
  (`submitPinEntry`'s setup-confirm and verify branches) were updated to
  `await enterApp()` — both call sites are themselves inside `async
  function submitPinEntry()`, so this doesn't introduce an unhandled
  promise.
- `doLogout()`, `resetPinWithRecovery()`, and `performMasterReset()` all
  call `endAuthenticatedSession()` (fire-and-forget in the first two,
  matching this file's existing convention for non-critical background
  writes like `writeAuditLog`; awaited inside the transaction for the
  third) — traced by hand to confirm none of the three paths can leave a
  stale session token behind in only `sessionStorage` or only `meta`.
- `performMasterReset()`'s six `.clear()` calls plus the
  `migrationVersion` marker write are all inside one
  `libraryDB.transaction('rw', ...)` block — confirmed by reading the
  call back, not just by writing it — so a failure partway through
  cannot leave some tables cleared and others not.
- `CACHE_VERSION` bump confirmed as the only change made to `sw.js` this
  session — the rest of the file (install/activate/fetch handlers,
  `RUNTIME_HOSTS`, `SHELL_ASSETS`) is byte-for-byte unchanged.
- Source-audited again for secret exposure: the new session token is
  never logged, never written into any DOM attribute or element text,
  and is confirmed by hand to have no code path that reads it back out
  and derives or reconstructs the PIN or recovery code from it (it
  cannot, since it was never generated from either).

**Not checked this session (unchanged from before, still applies):**
real QR camera scanning, real `.xlsx` binary parsing, real PDF
rendering, and PWA installability all still require a real hosted
browser session to verify, as documented in the previous "Real-browser
testing performed" section above — none of that surface was touched
this session, so its prior verification status is unchanged.

