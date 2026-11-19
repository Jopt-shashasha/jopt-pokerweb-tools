import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Database, Statement } from './database.js';

export class Store implements Database {
 readonly db: DatabaseSync;
 private depth=0;
 constructor(filename: string) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  this.db = new DatabaseSync(filename);
  this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  if (filename !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL;');
  this.db.exec('CREATE TABLE IF NOT EXISTS migrations(name TEXT PRIMARY KEY)');
  const dir = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
   if (this.one('SELECT name FROM migrations WHERE name=?', name)) continue;
   this.transaction(() => { this.db.exec(readFileSync(new URL(name, dir), 'utf8')); this.run('INSERT INTO migrations VALUES (?)', name); });
  }
 }
 one<T = Record<string, unknown>>(sql: string, ...values: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...values) as T | undefined; }
 all<T = Record<string, unknown>>(sql: string, ...values: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...values) as T[]; }
 run(sql: string, ...values: SQLInputValue[]) { return this.db.prepare(sql).run(...values); }
 batch(statements: readonly Statement[]) {
  this.transaction(() => { for (const [sql,...parameters] of statements) this.run(sql,...parameters); });
 }
 transaction<T>(fn: () => T): T {
  const nested=this.depth>0,savepoint=`portal_sp_${this.depth}`;
  this.db.exec(nested?`SAVEPOINT ${savepoint}`:'BEGIN IMMEDIATE');this.depth++;
  try { const v=fn();this.db.exec(nested?`RELEASE SAVEPOINT ${savepoint}`:'COMMIT');return v; }
  catch(e){this.db.exec(nested?`ROLLBACK TO SAVEPOINT ${savepoint}`:'ROLLBACK');if(nested)this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);throw e;}
  finally{this.depth--;}
 }
 close() { this.db.close(); }
}
