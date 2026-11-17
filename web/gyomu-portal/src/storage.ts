import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

// The HTTP/domain layer only uses this port. A hosted R2 adapter can replace it.
export interface BlobStore { put(bytes: Uint8Array): Promise<string>; get(id: string): Promise<Uint8Array<ArrayBuffer>>; remove(id: string): Promise<void> }
export class LocalBlobs implements BlobStore {
 constructor(private dir: string) {}
 private path(id: string) { if (!/^[0-9a-f-]{36}$/.test(id)) throw Error('Invalid blob ID'); return join(this.dir, id); }
 async put(bytes: Uint8Array) { await mkdir(this.dir, { recursive: true }); const id = randomUUID(); await writeFile(this.path(id), bytes, { flag: 'wx' }); return id; }
 async get(id: string) { return new Uint8Array(await readFile(this.path(id))); }
 async remove(id: string) { await unlink(this.path(id)).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
export const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
