/**
 * Cover store: image files on disk, index in SQLite alongside them.
 *
 * Beyond "where is the file", the index records when a lookup last failed (so misses
 * expire) and the content hash of every image (so placeholders can be spotted).
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Image } from './providers.ts';

export type Cover = { file: string; type: string };

export type Lookup = { status: 'hit'; cover: Cover } | { status: 'miss' } | { status: 'unknown' };

const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif' };

export class Store {
  #db: DatabaseSync;
  #dir: string;
  #missTtlMs: number;

  constructor(dir: string, dbPath: string, missTtlDays: number) {
    this.#dir = dir;
    this.#missTtlMs = missTtlDays * 86_400_000;
    mkdirSync(dir, { recursive: true });

    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS covers (
        isbn       TEXT PRIMARY KEY,
        file       TEXT,
        type       TEXT,
        source     TEXT,
        hash       TEXT,
        found      INTEGER NOT NULL,
        checked_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS covers_hash ON covers (hash);

      CREATE TABLE IF NOT EXISTS placeholders (
        hash       TEXT PRIMARY KEY,
        source     TEXT,
        seen       INTEGER NOT NULL,
        learned_at INTEGER NOT NULL
      );
    `);
  }

  lookup(isbn: string): Lookup {
    const row = this.#db
      .prepare('SELECT file, type, found, checked_at FROM covers WHERE isbn = ?')
      .get(isbn) as { file: string | null; type: string | null; found: number; checked_at: number } | undefined;

    if (!row) return { status: 'unknown' };

    if (row.found) {
      // Trust the index only as far as the file still exists.
      if (row.file && existsSync(join(this.#dir, row.file))) {
        return { status: 'hit', cover: { file: row.file, type: row.type ?? 'image/jpeg' } };
      }
      this.forget(isbn);
      return { status: 'unknown' };
    }

    if (Date.now() - row.checked_at > this.#missTtlMs) return { status: 'unknown' };
    return { status: 'miss' };
  }

  /** The curated cover for this ISBN, if one was uploaded. Curated covers outrank providers. */
  curated(isbn: string): Cover | null {
    const row = this.#db
      .prepare(`SELECT file, type FROM covers WHERE isbn = ? AND found = 1 AND source = 'upload'`)
      .get(isbn) as { file: string | null; type: string | null } | undefined;

    if (!row?.file || !existsSync(join(this.#dir, row.file))) return null;
    return { file: row.file, type: row.type ?? 'image/jpeg' };
  }

  /** Record the outcome of a fetch: the image if one was found, null if nothing was. */
  record(isbn: string, img: (Image & { hash: string }) | null): Cover | null {
    const cover = img ? { file: isbn + (EXT[img.contentType] ?? '.jpg'), type: img.contentType } : null;

    // A replacement of a different type lands under a different name; drop the old file.
    const prev = this.#db.prepare('SELECT file FROM covers WHERE isbn = ?').get(isbn) as
      | { file: string | null }
      | undefined;
    if (prev?.file && prev.file !== cover?.file) {
      try {
        unlinkSync(join(this.#dir, prev.file));
      } catch {
        /* already gone */
      }
    }

    if (img && cover) writeFileSync(join(this.#dir, cover.file), img.bytes);

    this.#db
      .prepare(
        `INSERT INTO covers (isbn, file, type, source, hash, found, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(isbn) DO UPDATE SET file = excluded.file, type = excluded.type,
                                         source = excluded.source, hash = excluded.hash,
                                         found = excluded.found, checked_at = excluded.checked_at`,
      )
      .run(isbn, cover?.file ?? null, cover?.type ?? null, img?.source ?? null, img?.hash ?? null, img ? 1 : 0, Date.now());

    return cover;
  }

  forget(isbn: string): void {
    const row = this.#db.prepare('SELECT file FROM covers WHERE isbn = ?').get(isbn) as { file: string | null } | undefined;
    if (row?.file) {
      try {
        unlinkSync(join(this.#dir, row.file));
      } catch {
        /* already gone */
      }
    }
    this.#db.prepare('DELETE FROM covers WHERE isbn = ?').run(isbn);
  }

  isPlaceholder(hash: string): boolean {
    return this.#db.prepare('SELECT 1 FROM placeholders WHERE hash = ?').get(hash) !== undefined;
  }

  /** How many distinct ISBNs already hold this exact image. Curated covers do not count. */
  countHash(hash: string, exceptIsbn: string): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM covers
         WHERE hash = ? AND isbn <> ? AND found = 1 AND COALESCE(source, '') <> 'upload'`,
      )
      .get(hash, exceptIsbn) as { n: number };
    return row.n;
  }

  /**
   * Record a "no cover" graphic and drop everything already cached under it.
   *
   * Dropped rather than marked as a miss: the remaining providers were never asked, so
   * those ISBNs go back to "unknown" instead of sitting behind the miss TTL for a month.
   * Curated covers are never dropped.
   */
  markPlaceholder(hash: string, source: string, seen: number): number {
    const affected = this.#db
      .prepare(`SELECT isbn FROM covers WHERE hash = ? AND COALESCE(source, '') <> 'upload'`)
      .all(hash) as { isbn: string }[];
    this.#db
      .prepare('INSERT OR REPLACE INTO placeholders (hash, source, seen, learned_at) VALUES (?, ?, ?, ?)')
      .run(hash, source, seen, Date.now());
    for (const { isbn } of affected) this.forget(isbn);
    return affected.length;
  }

  path(file: string): string {
    return join(this.#dir, file);
  }

  /** Cheap, stable ETag: the file identity, not its contents. */
  etag(file: string): string {
    const s = statSync(this.path(file));
    return `"${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}"`;
  }

  stats() {
    const totals = this.#db
      .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(found), 0) AS found FROM covers')
      .get() as { total: number; found: number };
    const bySource = this.#db
      .prepare('SELECT source, COUNT(*) AS n FROM covers WHERE found = 1 GROUP BY source ORDER BY n DESC')
      .all() as { source: string; n: number }[];
    const placeholders = this.#db
      .prepare('SELECT hash, source, seen FROM placeholders')
      .all() as { hash: string; source: string; seen: number }[];
    return { ...totals, misses: totals.total - totals.found, bySource, placeholders };
  }
}
