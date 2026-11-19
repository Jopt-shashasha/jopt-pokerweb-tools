import type { D1Database } from '@cloudflare/workers-types';
import type { Database, SqlValue, Statement } from './database.js';

export class D1Store implements Database {
 constructor(private binding: D1Database) {}

 private prepare(sql: string, parameters: SqlValue[]) {
  const statement = this.binding.prepare(sql);
  return parameters.length ? statement.bind(...parameters) : statement;
 }

 async one<T>(sql: string, ...parameters: SqlValue[]) {
  return (await this.prepare(sql, parameters).first<T>()) ?? undefined;
 }

 async all<T>(sql: string, ...parameters: SqlValue[]) {
  return (await this.prepare(sql, parameters).all<T>()).results;
 }

 async run(sql: string, ...parameters: SqlValue[]) {
  return { changes: (await this.prepare(sql, parameters).run()).meta.changes };
 }

 async batch(statements: readonly Statement[]) {
  if (statements.length) await this.binding.batch(statements.map(([sql,...parameters]) => this.prepare(sql,parameters)));
 }
}
