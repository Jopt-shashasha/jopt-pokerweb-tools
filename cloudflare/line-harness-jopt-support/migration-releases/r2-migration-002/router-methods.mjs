// Replacement methods for the existing verified HarnessR2TestStorage class.
const harnessR2RouterMethods = {
  globalR2Reads() {
    return this.env.R2_MIGRATION_READS === 'enabled' || ['all', 'all-mirror'].includes(this.env.R2_WRITE_MODE);
  },
  async put(key, value, options) {
    const mode = this.env.R2_WRITE_MODE;
    const image = options?.httpMetadata?.contentType?.toLowerCase().startsWith('image/');
    const selected = mode === 'test' && await this.isTestKey(key);
    const all = image && ['all', 'all-mirror'].includes(mode);
    if (!selected && !all) return this.legacy.put(key, value, options);
    if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw new Error('R2 image must be buffered bytes');
    // 'all' removes the Appwrite dependency for new images. The other enabled
    // modes retain strict mirroring until the rollout checks have completed.
    if (mode !== 'all') await this.legacy.put(key, value, options);
    return this.env.IMAGES_R2.put(key, value, options);
  },
  async get(key) {
    if (this.globalR2Reads() || await this.isTestKey(key)) {
      try {
        const object = await this.env.IMAGES_R2.get(key);
        if (object) return object;
      } catch { console.error('[r2-storage] read unavailable; using Appwrite copy'); }
    }
    return this.legacy.get(key);
  },
  async delete(key) {
    if (!this.globalR2Reads() && !await this.isTestKey(key)) return this.legacy.delete(key);
    const results = await Promise.allSettled([this.legacy.delete(key), this.env.IMAGES_R2.delete(key)]);
    if (results.some(result => result.status === 'rejected')) throw new Error('Image cleanup incomplete');
  }
};
export { harnessR2RouterMethods };
