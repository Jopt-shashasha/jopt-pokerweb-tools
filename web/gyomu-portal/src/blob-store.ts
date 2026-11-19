import { createHash } from 'node:crypto';

export interface BlobStore {
 put(bytes: Uint8Array): Promise<string>;
 get(id: string): Promise<Uint8Array<ArrayBuffer>>;
 remove(id: string): Promise<void>;
}

export const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
