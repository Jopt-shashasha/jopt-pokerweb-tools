import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { impactInput } from './impact.js';
export const httpUrl = z.string().trim().max(4000).refine(s => {
 try { const u = new URL(s); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}, 'http(s)のURLを指定してください。');
export const resourceInput = z.object({
 title: z.string().trim().min(1).max(160), description: z.string().trim().max(12000).default(''),
 url: httpUrl, creator_id: z.string().uuid().optional(),
 department_id: z.string().max(100).nullable().default(null), kind: z.enum(['document','tool']).nullable().default(null),
 event: z.string().trim().max(100).nullable().default(null), edition: z.string().trim().max(100).nullable().default(null),
 event_scope_id:z.string().max(100).nullable().optional(), search_text:z.string().max(120000).optional(),
 events:z.array(z.object({event:z.string().trim().min(1).max(100),event_scope_id:z.string().max(100).nullable().optional()}).strict()).max(20).optional().describe('All relevant tournament tags from portal_registration_options. Multiple tournaments allowed. Scope belongs to that tournament. An empty array explicitly clears tournament tags.'),
 tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
 visibility: z.enum(['company','private']).default('company'), status: z.enum(['draft','published','archived']).default('published'),
 impact: impactInput.nullable().optional(),
 access_request: z.boolean().default(false), version: z.number().int().positive().optional()
}).strict();
export function parseResource(value: unknown) {
 const r = resourceInput.safeParse(value);
 if (!r.success) throw new HTTPException(400, { message: r.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join(' / ') });
 return r.data;
}
export function imageType(bytes: Uint8Array): string | null {
 if (bytes[0]===0x89 && Buffer.from(bytes.subarray(1,8)).equals(Buffer.from([0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
 if (bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff) return 'image/jpeg';
 if (Buffer.from(bytes.subarray(0,4)).toString()==='RIFF' && Buffer.from(bytes.subarray(8,12)).toString()==='WEBP') return 'image/webp';
 return null;
}
