// 効果の一行：「カスタマー向け｜タイトル」「Voucher照合が 5分 → 30秒（1日20件）」
// Built by a fixed template (no model call). Used by portal cards, Slack and Codex.
import { z } from 'zod';

const text=(max:number)=>z.string().trim().max(max).optional().transform(v=>v||undefined);
export const impactInput=z.object({
 audience:text(40).describe('Who uses it, e.g. カスタマー担当'),
 task:text(60).describe('Which work gets easier, e.g. Voucher照合'),
 before:text(30).describe('Time or effort before, e.g. 5分/件'),
 after:text(30).describe('Time or effort after, e.g. 30秒/件'),
 frequency:text(40).describe('How often the work happens, e.g. 1日20件'),
}).strict().describe('Optional effect line. Ask the creator for these values; never invent numbers.');
export type Impact=Partial<Record<'audience'|'task'|'before'|'after'|'frequency',string>>;

export function cleanImpact(value:Impact|null|undefined):Impact|null{
 if(!value)return null;
 const entries=Object.entries(value).filter(([,v])=>typeof v==='string'&&v.trim());
 return entries.length?Object.fromEntries(entries) as Impact:null;
}
export function parseStoredImpact(raw:string|null|undefined):Impact|null{
 if(!raw)return null;try{const r=impactInput.safeParse(JSON.parse(raw));return r.success?cleanImpact(r.data):null;}catch{return null;}
}
export function impactHeadline(title:string,department:string|null|undefined,impact:Impact|null){
 if(!impact)return null;
 const who=impact.audience||department||null;
 const label=(who?`${who}向け｜`:'')+title;
 let effect=impact.before&&impact.after?`${impact.task?impact.task+'が ':''}${impact.before} → ${impact.after}`:impact.task??'';
 if(effect&&impact.frequency)effect+=`（${impact.frequency}）`;
 return effect?{label,effect,text:`${label}：${effect}`}:null;
}
