import { z } from 'zod';
import { httpUrl } from './validation.js';

const lines=z.array(z.string().trim().min(1).max(600)).max(8).default([]);
export const readerGuideInput=z.object({
 summary:z.string().trim().min(1).max(500),
 requirements:lines,steps:lines,key_points:lines,notes:lines,
 related_links:z.array(z.object({label:z.string().trim().min(1).max(100),url:httpUrl}).strict()).max(8).default([]),
 status:z.enum(['draft','confirmed']).default('draft'),
 source_note:z.string().trim().min(1).max(500),
 suggested_kind:z.enum(['document','tool']).nullable().default(null),
 suggested_tags:z.array(z.string().trim().min(1).max(60)).max(12).default([])
}).strict();
export const readerGuideUpdate=z.object({version:z.number().int().positive(),guide:readerGuideInput}).strict();
export type ReaderGuide=z.infer<typeof readerGuideInput>;
