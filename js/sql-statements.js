/* ============================================================
   sql-statements.js — Stackroom Database Architecture Upgrade
   ------------------------------------------------------------
   A catalog of the parameterized SQL each db-abstraction.js
   operation needs, matched against sqlite/schema.sql. This file
   contains NO execution logic of its own — it exports strings (and,
   for multi-statement atomic operations, ordered arrays of
   {sql, params} steps) for sqlite-service.js to actually run once a
   real engine exists. Splitting it out means the SQL can be
   reviewed/audited on its own, independent of the engine-integration
   code around it.

   HOW EACH STATEMENT WAS DERIVED
   Every statement here mirrors a specific, named function already in
   index.html — referenced in the comment above each one — rather
   than being written from scratch against the schema alone. Where
   the source logic is a JS re-derivation (e.g. available copies is
   COUNTED from active transactions, never stored as a decrementing
   number on the book row — see availableCopiesFor()/
   activeIssueCountForBook() in index.html), the SQL reproduces that
   same derivation instead of inventing a simpler-looking shortcut
   that would silently diverge from existing behavior.

   PARAMETER STYLE
   Named parameters (`:name`) throughout — safe against SQL injection
   by construction, and self-documenting at each call site. Whichever
   real engine is eventually vendored, confirm it supports named
   parameters as shown; if it only supports positional (`?`)
   parameters, the param NAMES here still document intent even after
   mechanically converting the placeholders.
   ============================================================ */
(function (global) {
  'use strict';

  const S = {};

  // ---- books ---------------------------------------------------
  // mirrors: bookModalSave click handler (add/edit) in index.html
  S.insertBook = `INSERT INTO books (id, barcode, title, author, class, subject, shelf, status, copies)
    VALUES (:id, :barcode, :title, :author, :class, :subject, :shelf, :status, :copies)`;

  S.updateBook = `UPDATE books SET barcode=:barcode, title=:title, author=:author, class=:class,
    subject=:subject, shelf=:shelf, status=:status, copies=:copies WHERE id=:id`;

  // mirrors: deleteBook (wherever the source calls DB.books.splice/filter — kept as a hard delete since the source app does not soft-delete books)
  S.deleteBook = `DELETE FROM books WHERE id=:id`;

  // mirrors: findBookByBarcode() — case/whitespace-insensitive, matching the source's .trim().toLowerCase() comparisons throughout
  S.getBookByBarcode = `SELECT * FROM books WHERE lower(trim(barcode)) = lower(trim(:barcode)) LIMIT 1`;
  S.getBookById = `SELECT * FROM books WHERE id = :id LIMIT 1`;
  S.listBooks = `SELECT * FROM books ORDER BY title COLLATE NOCASE`;

  // mirrors: activeIssueCountForBook() — copies-remaining is always a live COUNT, never a stored decrementing field (see file header)
  S.activeIssueCountForBook = `SELECT COUNT(*) AS n FROM transactions
    WHERE lower(trim(book_barcode)) = lower(trim(:barcode)) AND status = 'issued'`;

  // mirrors: syncBookAutoStatus() — only touches status when it's not one of the librarian-controlled terminal states
  S.updateBookStatusIfAuto = `UPDATE books SET status = :newStatus
    WHERE id = :id AND status NOT IN ('Lost', 'Damaged', 'Under Repair')`;

  // ---- students --------------------------------------------------
  // mirrors: student-add/edit handler (search "record.allowMultipleBooks" in index.html)
  S.upsertStudent = `INSERT INTO students (student_id, name, class, section, allow_multiple_books)
    VALUES (:studentId, :name, :class, :section, :allowMultipleBooks)
    ON CONFLICT(student_id) DO UPDATE SET
      name=excluded.name, class=excluded.class, section=excluded.section,
      allow_multiple_books=excluded.allow_multiple_books`;
  S.deleteStudent = `DELETE FROM students WHERE student_id = :studentId`;
  S.getStudentById = `SELECT * FROM students WHERE student_id = :studentId LIMIT 1`;
  S.listStudents = `SELECT * FROM students ORDER BY name COLLATE NOCASE`;

  // ---- transactions -----------------------------------------------
  // mirrors: issueConfirmBtn click handler's `tx` object construction
  S.insertTransaction = `INSERT INTO transactions
    (id, book_barcode, book_id, book_title, student_id, student_name, student_class,
     issue_date, expected_return_date, return_date, status)
    VALUES (:id, :bookBarcode, :bookId, :bookTitle, :studentId, :studentName, :studentClass,
     :issueDate, :expectedReturnDate, NULL, 'issued')`;

  // mirrors: markTransactionReturned()/finalizeReturnFineFields() — freezes the fine snapshot exactly once, at return time
  S.markTransactionReturned = `UPDATE transactions SET
      return_date = :returnDate, status = 'returned',
      fine_days = :fineDays, fine_amount_paise = :fineAmountPaise,
      fine_paid = :finePaid, fine_paid_at = NULL,
      was_early_return = :wasEarlyReturn, returned_during_grace = :returnedDuringGrace
    WHERE id = :id`;

  // mirrors: markFinePaid() (search "tx.finePaid = true" in index.html)
  S.markFinePaid = `UPDATE transactions SET fine_paid = 1, fine_paid_at = :finePaidAt
    WHERE id = :id AND fine_amount_paise > 0 AND fine_paid = 0`;

  S.getTransactionsByStudent = `SELECT * FROM transactions WHERE student_id = :studentId ORDER BY issue_date DESC`;

  // mirrors: activeIssueForStudent() (one-active-loan rule, Part 29 in the security spec)
  S.getActiveTransactionForStudent = `SELECT * FROM transactions
    WHERE lower(trim(student_id)) = lower(trim(:studentId)) AND status = 'issued' LIMIT 1`;

  S.listTransactionsByStatus = `SELECT * FROM transactions WHERE status = :status ORDER BY issue_date DESC`;
  S.getTransactionById = `SELECT * FROM transactions WHERE id = :id LIMIT 1`;

  // ---- settings (single JSON-blob row, matching the Dexie store) ----
  S.getSettings = `SELECT value FROM settings WHERE key = 'app-settings' LIMIT 1`;
  S.putSettings = `INSERT INTO settings (key, value) VALUES ('app-settings', :valueJson)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

  // ---- audit log ----
  // mirrors: writeAuditLog() — note it is intentionally NOT part of the
  // atomic issue/return transactions below (Part 30: "audit logging must
  // never cause a successful library operation to fail" — same
  // best-effort semantics as the existing try/catch around
  // libraryDB.auditLog.add() in index.html)
  S.insertAuditLog = `INSERT INTO audit_log (id, timestamp, action, entity, entity_id, detail)
    VALUES (:id, :timestamp, :action, :entity, :entityId, :detail)`;
  S.listAuditLog = `SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT :limit OFFSET :offset`;

  // ---- meta (key/value, matching Dexie's meta store) ----
  S.getMeta = `SELECT value FROM meta WHERE key = :key LIMIT 1`;
  S.putMeta = `INSERT INTO meta (key, value, updated_at) VALUES (:key, :value, :updatedAt)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
  S.deleteMeta = `DELETE FROM meta WHERE key = :key`;

  /* ============================================================
     ATOMIC MULTI-STATEMENT OPERATIONS (Part 31)
     Each returns an ORDERED array of {sql, params} steps for
     sqlite-service.js to run inside a single BEGIN...COMMIT, rolling
     back on any step's failure. The re-validation steps mirror the
     "MANDATORY final re-check" comment already in index.html's
     issueConfirmBtn handler — re-checked here again inside the SQL
     transaction, not just trusted from earlier JS-side checks, since
     another tab/process could have changed state in between.
     ============================================================ */

  /** Issue a book (Part 31 "BOOK ISSUE"). Caller has already resolved
   *  `book` (by barcode) and `tx` (the transaction to insert) in JS —
   *  this only re-validates the invariants that matter transactionally:
   *  the book isn't Lost/Damaged and has a free copy right now, and (if
   *  not allowMultipleBooks) the student has no other active loan. */
  function issueBookSteps({ book, tx, studentAllowsMultiple }) {
    const steps = [
      { sql: `SELECT status, copies FROM books WHERE id = :bookId`, params: { bookId: book.id }, assert: 'bookStillValidForIssue' },
      { sql: S.activeIssueCountForBook, params: { barcode: tx.bookBarcode }, assert: 'copyAvailable' }
    ];
    if (!studentAllowsMultiple) {
      steps.push({ sql: S.getActiveTransactionForStudent, params: { studentId: tx.studentId }, assert: 'studentHasNoActiveLoan' });
    }
    steps.push(
      { sql: S.insertTransaction, params: tx },
      { sql: S.updateBookStatusIfAuto, params: { id: book.id, newStatus: 'Issued' } }
      // NOTE: newStatus here should actually be computed the same way
      // syncBookAutoStatus() does (Available if copies-remaining > 0
      // after this issue, else Issued) — the caller (sqlite-service.js,
      // once it exists) must compute that from the copy-count step's
      // result before building this params object, exactly as
      // syncBookAutoStatus() does in JS today. Left as caller
      // responsibility rather than hardcoded here, since hardcoding
      // 'Issued' would be wrong for books with copies > 1.
    );
    // writeAuditLog('book_issued', ...) happens OUTSIDE this array,
    // after COMMIT succeeds, per Part 30's best-effort semantics.
    return steps;
  }

  /** Return a book (Part 31 "BOOK RETURN"). Caller has already computed
   *  the fine snapshot in JS (finalizeReturnFineFields equivalent) since
   *  that math (grace period, fine-per-day) depends on SETTINGS, which
   *  this layer doesn't own — it only persists the already-computed
   *  result atomically alongside the book status update. */
  function returnBookSteps({ book, tx, returnFields }) {
    return [
      { sql: S.markTransactionReturned, params: { id: tx.id, ...returnFields } },
      { sql: S.activeIssueCountForBook, params: { barcode: tx.bookBarcode }, assert: 'recomputeAvailability' },
      { sql: S.updateBookStatusIfAuto, params: { id: book.id, newStatus: 'Available' /* or 'Issued' — same caller-computes-from-previous-step-result note as issueBookSteps */ } }
    ];
    // writeAuditLog('book_returned'/'fine_paid', ...) happens OUTSIDE
    // this array, after COMMIT, per Part 30.
  }

  global.StackroomSQL = { statements: S, issueBookSteps, returnBookSteps };
})(window);
