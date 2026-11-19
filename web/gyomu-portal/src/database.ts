import { HTTPException } from 'hono/http-exception';

export type SqlValue = string | number | null;
export type Statement = readonly [sql: string, ...parameters: SqlValue[]];
type MaybePromise<T> = T | Promise<T>;

export interface Database {
 one<T = Record<string, unknown>>(sql: string, ...parameters: SqlValue[]): MaybePromise<T | undefined>;
 all<T = Record<string, unknown>>(sql: string, ...parameters: SqlValue[]): MaybePromise<T[]>;
 run(sql: string, ...parameters: SqlValue[]): MaybePromise<{ changes: number | bigint }>;
 batch(statements: readonly Statement[]): MaybePromise<void>;
}

// The table stays empty. A failed condition violates its CHECK constraint and
// rolls back the entire D1 batch, including any preceding statements.
export function requireSql(condition: string, ...parameters: SqlValue[]): Statement {
 return ['INSERT INTO portal_batch_guard (ok) SELECT 0 WHERE NOT COALESCE(('+condition+'),0)', ...parameters];
}

export function isBatchConflict(error: unknown) {
 return error instanceof Error && error.message.includes('portal_precondition');
}

export async function commit(store: Database, statements: readonly Statement[], message: string) {
 try {
  await store.batch(statements);
 } catch (error) {
  if (isBatchConflict(error)) throw new HTTPException(409, { message });
  throw error;
 }
}

export async function rateLimit(store: Database, key: string, time: number) {
 const row = await store.one<{ count: number }>(`INSERT INTO portal_rate_limits(key,count,expires_at)
  VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET
  count=CASE WHEN expires_at<=? THEN 1 ELSE MIN(count+1,21) END,
  expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count`,key,time+60,time,time);
 if (!row || row.count>20) throw new HTTPException(429,{message:'しばらく待ってから実行してください。'});
 if (Math.random()<0.02) await store.run('DELETE FROM portal_rate_limits WHERE expires_at<=?',time);
}
