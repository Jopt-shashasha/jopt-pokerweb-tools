const HARNESS_MIGRATION_MAX_BYTES = 10 * 1024 * 1024;
function harnessMigrationKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 1024 &&
    !/[\x00-\x1f\x7f\\]/.test(key) && !key.startsWith('/') &&
    !key.startsWith('_migration/') && !key.split('/').some(p => p === '.' || p === '..');
}
async function harnessMigrationAllowed(db, key) {
  if (!harnessMigrationKey(key)) return false;
  const line = /^line-private\/([^/]+)\/([^/]+)\/[^/]+$/.exec(key);
  if (line) {
    const row = await db.prepare('SELECT state,storage_key FROM line_incoming_images WHERE account_id=? AND message_id=?')
      .bind(line[1], line[2]).first();
    return row?.state === 'stored' && row.storage_key === key;
  }
  if (key.startsWith('line-private/')) return false;
  const faq = /^faq-private\/([^/]+)\/[^/]+$/.exec(key);
  if (faq) {
    const row = await db.prepare('SELECT state,storage_key FROM faq_case_uploads WHERE case_id=?').bind(faq[1]).first();
    return row?.state === 'stored' && row.storage_key === key;
  }
  if (key.startsWith('faq-private/')) return false;
  if (key.startsWith('incoming-')) {
    return !await db.prepare('SELECT storage_key FROM line_legacy_image_unsends WHERE storage_key=?').bind(key).first();
  }
  return true;
}
async function harnessMigrationBytes(object) {
  const reader = object.body.getReader();
  const parts = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > HARNESS_MIGRATION_MAX_BYTES) throw new Error('image_too_large');
      parts.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}
async function harnessMigrationHash(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
async function harnessMigrateOne(db, source, destination, key) {
  if (!await harnessMigrationAllowed(db, key)) return { key, status: 'skipped_withdrawn_or_unlinked' };
  const original = await source.get(key);
  if (!original) return { key, status: 'source_missing' };
  const type = original.httpMetadata?.contentType || '';
  if (!type.toLowerCase().startsWith('image/')) {
    await original.body.cancel().catch(() => {});
    return { key, status: 'skipped_non_image' };
  }
  const bytes = await harnessMigrationBytes(original);
  const sha256 = await harnessMigrationHash(bytes);
  if (!await harnessMigrationAllowed(db, key)) return { key, status: 'skipped_withdrawn_or_unlinked' };
  const existing = await destination.get(key);
  let status = 'verified_existing';
  if (existing) {
    if (await harnessMigrationHash(await harnessMigrationBytes(existing)) !== sha256) {
      return { key, status: 'conflict_not_overwritten' };
    }
  } else {
    // Appwrite originals are deliberately never modified or deleted here.
    await destination.put(key, bytes, {
      httpMetadata: { contentType: type },
      customMetadata: { harnessMigration: 'r2-migration-002', sha256 }
    });
    const copied = await destination.get(key);
    if (!copied || await harnessMigrationHash(await harnessMigrationBytes(copied)) !== sha256) {
      // Only remove a newly created, invalid copy; the source is untouched.
      await destination.delete(key);
      throw new Error('verification_failed');
    }
    status = 'copied_verified';
  }
  // An unsend can arrive during download/upload. Never resurrect its copy.
  if (!await harnessMigrationAllowed(db, key)) {
    await destination.delete(key);
    return { key, status: 'withdrawn_during_copy' };
  }
  return { key, status, bytes: bytes.byteLength, sha256 };
}
async function harnessMigrateBatch(env, source, keys) {
  if (env.R2_MIGRATION_ENABLED !== '1' || env.R2_MIGRATION_READS !== 'enabled' || !env.IMAGES_R2) {
    throw new Error('migration_disabled');
  }
  if (!Array.isArray(keys) || !keys.length || keys.length > 3 || keys.some(key => !harnessMigrationKey(key))) {
    throw new Error('invalid_batch');
  }
  const results = [];
  for (const key of new Set(keys)) {
    try { results.push(await harnessMigrateOne(env.DB, source, env.IMAGES_R2, key)); }
    catch (error) {
      results.push({ key, status: 'failed', reason: error?.message === 'image_too_large' ? 'image_too_large' : 'copy_or_verify_failed' });
    }
  }
  // Private, append-only audit objects allow interrupted batches to be traced.
  const audit = { release: 'r2-migration-002', at: new Date().toISOString(), results };
  await env.IMAGES_R2.put('_migration/r2-migration-002/' + crypto.randomUUID() + '.json', JSON.stringify(audit),
    { httpMetadata: { contentType: 'application/json' } });
  return audit;
}
export { harnessMigrationAllowed, harnessMigrationBytes, harnessMigrationHash, harnessMigrationKey, harnessMigrateOne, harnessMigrateBatch };
