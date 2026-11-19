import type { R2Bucket } from '@cloudflare/workers-types';
import type { BlobStore } from './blob-store.js';

export class R2Blobs implements BlobStore {
 constructor(private bucket: R2Bucket) {}

 async get(id: string) {
  const item = await this.bucket.get(id);
  if (!item) throw new Error('Stored object not found');
  return new Uint8Array(await item.arrayBuffer());
 }

 async put(bytes: Uint8Array) {
  const id = crypto.randomUUID();
  await this.bucket.put(id, Uint8Array.from(bytes).buffer);
  return id;
 }

 async remove(id: string) {
  await this.bucket.delete(id);
 }
}
