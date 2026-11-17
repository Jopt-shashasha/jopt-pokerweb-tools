// r2-test-001: inserted into the verified deployed bundle; not an old-source rebuild.
// IMAGES_R2 remains private. Test writes require BOTH stores to succeed so that
// the existing Appwrite-only release can still read successfully completed writes.
class HarnessR2TestStorage {
  constructor(env, legacy) {
    this.env = env;
    this.legacy = legacy;
  }

  async isTestKey(key) {
    const account = this.env.R2_TEST_ACCOUNT_ID;
    const user = this.env.R2_TEST_LINE_USER_ID;
    if (!account || !user || !this.env.IMAGES_R2 || !this.env.DB) return false;
    let row;
    const line = /^line-private\/([^/]+)\/([^/]+)\/[^/]+$/.exec(key);
    if (line) {
      if (line[1] !== account) return false;
      row = await this.env.DB.prepare(
        `SELECT line_user_id FROM line_incoming_images
         WHERE account_id=? AND message_id=? AND storage_key=?`
      ).bind(account, line[2], key).first();
    } else {
      const faq = /^faq-private\/([^/]+)\/[^/]+$/.exec(key);
      if (!faq) return false;
      row = await this.env.DB.prepare(
        `SELECT f.line_user_id FROM faq_case_uploads u
         JOIN faq_cases c ON c.id=u.case_id
         JOIN friends f ON f.id=c.friend_id AND f.line_account_id=c.account_id
         WHERE u.case_id=? AND u.storage_key=? AND c.account_id=?`
      ).bind(faq[1], key, account).first();
    }
    return row?.line_user_id === user;
  }

  async put(key, value, options) {
    if (this.env.R2_WRITE_MODE !== 'test' || !await this.isTestKey(key)) {
      return this.legacy.put(key, value, options);
    }
    // The verified live private-image paths pass buffered bytes. Never reuse a
    // consumed stream, or silently upload a stream for unrelated routes to R2.
    if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
      throw new Error('R2 test image must be buffered bytes');
    }
    await this.legacy.put(key, value, options);
    return this.env.IMAGES_R2.put(key, value, options);
  }

  async get(key) {
    // Read compatibility remains enabled when R2_WRITE_MODE is switched off.
    if (await this.isTestKey(key)) {
      try {
        const object = await this.env.IMAGES_R2.get(key);
        if (object) return object;
      } catch {
        console.error('[r2-test] read unavailable; using Appwrite copy');
      }
    }
    return this.legacy.get(key);
  }

  async delete(key) {
    if (!await this.isTestKey(key)) return this.legacy.delete(key);
    // Try both even if one provider fails. Reject incomplete cleanup so the
    // existing withdrawal/cleanup retry mechanism retries on the next tick.
    const results = await Promise.allSettled([
      this.legacy.delete(key), this.env.IMAGES_R2.delete(key)
    ]);
    if (results.some(result => result.status === 'rejected')) {
      throw new Error('R2 test image cleanup incomplete');
    }
  }

  list(options) {
    // Test uploads are mirrored, so the legacy list is still complete; other
    // image/video cleanup retains its original pagination and key semantics.
    return this.legacy.list(options);
  }
}

export { HarnessR2TestStorage };
