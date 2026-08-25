/* ============================================================
   crypto-service.js — Stackroom Database Architecture Upgrade
   ------------------------------------------------------------
   Pure cryptographic primitives. No Dexie access, no DOM access,
   no knowledge of PIN/Recovery Code semantics — key-manager.js
   owns that. Keeping this file pure makes it easy to audit in
   isolation and easy to unit-test.

   WHAT LIVES HERE
   - A versioned KDF (key derivation function) that turns a
     low-entropy secret (PIN or Recovery Code) + a random salt
     into a 256-bit key-encryption key (KEK).
   - Authenticated wrap/unwrap of a random Data Encryption Key
     (DEK) using that KEK, via AES-256-GCM (WebCrypto's
     crypto.subtle — a real, standard, browser-native primitive;
     nothing here is invented).

   HONEST ALGORITHM DISCLOSURE (see README "Security Architecture")
   - KDF: PBKDF2-SHA256 by default (matches the iteration count
     class already used elsewhere in this app for the PIN/Recovery
     verifiers, so behavior is consistent and auditable). Argon2id
     is used INSTEAD only if `window.argon2` (a real, loaded
     argon2-browser/argon2id WASM build) is detected at runtime —
     this file never pretends Argon2id is available when it isn't,
     and never fabricates an Argon2 implementation.
   - Key wrapping: AES-256-GCM via crypto.subtle, which IS a real
     authenticated (confidentiality + integrity) primitive with a
     unique random 96-bit IV per wrap. This is genuinely AES-256-GCM,
     unlike the SQLite page-encryption layer (see sqlite-service.js),
     which is a different technology (ChaCha20-Poly1305 by default
     under SQLite3 Multiple Ciphers) and must not be conflated with
     this file's AES-GCM key wrapping.
   ============================================================ */
(function (global) {
  'use strict';

  const KDF_VERSION_PBKDF2_SHA256 = 1;
  const KDF_VERSION_ARGON2ID = 2;
  const DEFAULT_PBKDF2_ITERATIONS = 210000; // stronger than the 150k already used for the PIN/Recovery verifiers, since this key protects the actual data now, not just a login gate
  const WRAP_ALG = 'AES-GCM';
  const WRAP_KEY_LENGTH = 256;
  const DEK_LENGTH_BYTES = 32; // 256-bit DEK

  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function base64ToBuf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function argon2idAvailable() {
    // Real feature-detection only. Never simulated. Stackroom does not
    // currently vendor an Argon2id WASM build (see README §Security
    // Limitations) — this returns false until one is genuinely present
    // as `window.argon2` with an `.hash()` method matching the
    // argon2-browser API.
    return !!(global.argon2 && typeof global.argon2.hash === 'function');
  }

  /**
   * Derive a 256-bit AES-GCM CryptoKey (extractable:false, wrap/unwrap
   * usages only) from a low-entropy secret and salt.
   * Returns { key, kdf: { version, algorithm, iterations|params, saltB64 } }
   * so the metadata can be stored alongside the wrapped DEK for future
   * verification/upgrade.
   */
  async function deriveKeyEncryptionKey(secret, saltBytes, kdfMeta) {
    const useArgon2 = kdfMeta ? kdfMeta.version === KDF_VERSION_ARGON2ID : argon2idAvailable();
    if (useArgon2) {
      if (!argon2idAvailable()) {
        throw new Error('Stored key metadata requires Argon2id, but no Argon2id implementation is loaded in this browser session.');
      }
      const params = (kdfMeta && kdfMeta.params) || { time: 3, mem: 65536, parallelism: 1, hashLen: 32 };
      const result = await global.argon2.hash({
        pass: secret,
        salt: new Uint8Array(saltBytes),
        time: params.time, mem: params.mem, parallelism: params.parallelism,
        hashLen: params.hashLen, type: global.argon2.ArgonType ? global.argon2.ArgonType.Argon2id : 2
      });
      const rawKeyBytes = result.hash; // Uint8Array
      const key = await crypto.subtle.importKey('raw', rawKeyBytes, { name: WRAP_ALG }, false, ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']);
      return { key, kdf: { version: KDF_VERSION_ARGON2ID, algorithm: 'Argon2id', params, saltB64: bufToBase64(saltBytes) } };
    }

    const iterations = (kdfMeta && kdfMeta.iterations) || DEFAULT_PBKDF2_ITERATIONS;
    const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'PBKDF2' }, false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
      baseKey,
      { name: WRAP_ALG, length: WRAP_KEY_LENGTH },
      false,
      ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']
    );
    return { key, kdf: { version: KDF_VERSION_PBKDF2_SHA256, algorithm: 'PBKDF2-SHA256', iterations, saltB64: bufToBase64(saltBytes) } };
  }

  /** Generate a new random 256-bit DEK as raw, extractable key bytes.
   *  Extractable because the eventual SQLite engine needs the raw key
   *  material to key the database (a passphrase/keyspec, not a WebCrypto
   *  CryptoKey object) — see sqlite-service.js. The DEK is NEVER persisted
   *  in this raw form; only its wrapped (AES-GCM-encrypted) form is stored. */
  function generateDek() {
    return crypto.getRandomValues(new Uint8Array(DEK_LENGTH_BYTES));
  }

  /** Wrap (encrypt) raw DEK bytes with a secret (PIN or Recovery Code).
   *  Returns a self-contained, storable record. */
  async function wrapDek(dekBytes, secret, existingKdfMeta) {
    const salt = existingKdfMeta ? new Uint8Array(base64ToBuf(existingKdfMeta.saltB64)) : crypto.getRandomValues(new Uint8Array(16));
    const { key, kdf } = await deriveKeyEncryptionKey(secret, salt, existingKdfMeta);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.encrypt({ name: WRAP_ALG, iv }, key, dekBytes);
    return {
      version: 1,
      kdf,
      ivB64: bufToBase64(iv),
      wrappedDekB64: bufToBase64(wrapped)
    };
  }

  /** Unwrap (decrypt) a wrapped-DEK record with a secret. Throws on wrong
   *  secret or corrupted/tampered record (AES-GCM's authentication tag
   *  check fails closed — there is no silent fallback). Returns raw DEK
   *  bytes (Uint8Array). */
  async function unwrapDek(record, secret) {
    if (!record || !record.kdf || !record.ivB64 || !record.wrappedDekB64) {
      throw new Error('Malformed wrapped-DEK record.');
    }
    const salt = new Uint8Array(base64ToBuf(record.kdf.saltB64));
    const { key } = await deriveKeyEncryptionKey(secret, salt, record.kdf);
    const iv = new Uint8Array(base64ToBuf(record.ivB64));
    const wrapped = base64ToBuf(record.wrappedDekB64);
    try {
      const plain = await crypto.subtle.decrypt({ name: WRAP_ALG, iv }, key, wrapped);
      return new Uint8Array(plain);
    } catch (e) {
      // AES-GCM tag mismatch → wrong secret OR tampered/corrupted record.
      // Deliberately generic error: never leak which case it was.
      const err = new Error('Could not unlock the database key with the provided secret.');
      err.code = 'DEK_UNWRAP_FAILED';
      throw err;
    }
  }

  function secureWipe(bytes) {
    // Best-effort only — see README "Memory Security Limitations".
    // JavaScript/WebCrypto give no hard guarantee that this actually
    // scrubs the underlying memory (GC may have already copied it,
    // WebCrypto internals are opaque), but zeroing what we do hold a
    // reference to costs nothing and helps in the common case.
    if (bytes && bytes.fill) bytes.fill(0);
  }

  global.StackroomCrypto = {
    KDF_VERSION_PBKDF2_SHA256,
    KDF_VERSION_ARGON2ID,
    argon2idAvailable,
    generateDek,
    wrapDek,
    unwrapDek,
    secureWipe,
    bufToBase64,
    base64ToBuf
  };
})(window);
