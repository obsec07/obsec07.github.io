// A stand-in for Cloudflare D1 on Node's built-in SQLite, so the API's tests run without Cloudflare.
// Covers what api/src/index.js uses: prepare().bind().first()/all()/run(), and batch() (all-or-nothing).
import { DatabaseSync } from 'node:sqlite';

export function d1() {
  const db = new DatabaseSync(':memory:');
  const plain = (r) => (r ? { ...r } : r);
  const returnsRows = (sql) => /^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql);
  const norm = (v) => {
    if (v === undefined) throw new Error('D1_TYPE_ERROR: undefined is not a supported value');
    return typeof v === 'boolean' ? Number(v) : v;
  };
  class Stmt {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...args) { return new Stmt(this.sql, args.map(norm)); }
    async first(col) { const r = plain(db.prepare(this.sql).get(...this.params)); return r == null ? null : col ? r[col] : r; }
    async all() { return { success: true, results: db.prepare(this.sql).all(...this.params).map(plain), meta: {} }; }
    async run() {
      if (returnsRows(this.sql)) return this.all();
      const i = db.prepare(this.sql).run(...this.params);
      return { success: true, results: [], meta: { changes: Number(i.changes), last_row_id: Number(i.lastInsertRowid) } };
    }
  }
  return {
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    sqlite: db,
  };
}
