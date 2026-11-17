import { load } from 'cheerio';
import { HTTPException } from 'hono/http-exception';
import { Store } from './db.js';
import type { BlobStore } from './storage.js';
import { now } from './model.js';

export const SEARCH_BODY_LIMIT=120000;
export const normalizeText=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
export const cleanTag=(text:string)=>text.normalize('NFKC').replace(/\s+/g,' ').trim();
const aliases=[['ticket','チケット'],['voucher','バウチャー'],['受付','reception'],['売上','販売数','販売','sales'],['議事録','meeting notes']].map(a=>a.map(normalizeText));
export function queryGroups(query:string){
 const clean=normalizeText(query).slice(0,160),stop=new Set(['の','を','に','で','が','は','と','へ','も','から','まで','こと','する','した','い','たい','です','ます','確認','検索','探す','探し','調べる']);
 const words=clean.includes(' ')?clean.split(' '):/[ぁ-んァ-ヶ一-龯]/.test(clean)?[...new Intl.Segmenter('ja',{granularity:'word'}).segment(clean)].filter(s=>s.isWordLike).map(s=>s.segment):[clean];
 const terms=[...new Set(words.filter(w=>w&&!stop.has(w)))].slice(0,8);
 return (terms.length?terms:[clean]).filter(Boolean).map(term=>aliases.find(a=>a.includes(term))??[term]);
}
export const likePattern=(value:string)=>'%'+value.replace(/[\\%_]/g,'\\$&')+'%';
export function htmlText(html:string){
 const $=load(html.slice(0,2*1024*1024));$('script,style,noscript,template,iframe,svg,canvas,[hidden],[aria-hidden="true"]').remove();
 const body=$('main,article').first();return (body.length?body:$('body')).text().replace(/\s+/g,' ').trim().slice(0,SEARCH_BODY_LIMIT);
}
export function indexResource(store:Store,id:string,body?:string){
 const r=store.one<any>(`SELECT r.*,u.name creator_name,u.email creator_email,d.name department_name,s.name scope_name FROM resources r JOIN users u ON u.id=r.creator_id LEFT JOIN departments d ON d.id=r.department_id LEFT JOIN event_scopes s ON s.id=r.event_scope_id WHERE r.id=?`,id);if(!r)return;
 const previous=store.one<{body:string}>('SELECT body FROM resource_search WHERE resource_id=?',id);
 const source=JSON.parse(r.source_metadata),base=(body??previous?.body??(typeof source.detail_text==='string'?source.detail_text:'')).slice(0,SEARCH_BODY_LIMIT);
 const markdown=store.one<{search_text:string}>('SELECT search_text FROM resource_markdown WHERE resource_id=?',id)?.search_text??'';
 const guideRow=store.one<{content:string}>('SELECT content FROM resource_reader_guides WHERE resource_id=?',id),guide=guideRow?JSON.parse(guideRow.content):null;
 const guideText=guide?[guide.summary,...guide.requirements,...guide.steps,...(guide.key_points??[]),...guide.notes,...guide.related_links.map((x:{label:string})=>x.label)].join(' '):'';
 const cats=store.all<{category_name:string}>('SELECT category_name FROM resource_categories WHERE resource_id=?',id).map(c=>c.category_name);
 const events=store.all<{event:string;name:string|null}>('SELECT re.event,s.name FROM resource_events re LEFT JOIN event_scopes s ON s.id=re.event_scope_id WHERE re.resource_id=?',id);
 const metadata=[r.title,r.description,r.creator_name,r.creator_email,r.department_name,...events.flatMap(e=>[e.event,e.name]),r.edition,...JSON.parse(r.tags),...cats].filter(Boolean).join(' ');
 store.run(`INSERT INTO resource_search(resource_id,body,normalized_text,normalized_title,normalized_summary,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET body=excluded.body,normalized_text=excluded.normalized_text,normalized_title=excluded.normalized_title,normalized_summary=excluded.normalized_summary,updated_at=excluded.updated_at`,id,base,normalizeText(metadata+' '+base+' '+markdown+' '+guideText),normalizeText(r.title),normalizeText(guide?.summary??r.description),now());
}
export function ensureSearchIndex(store:Store){for(const r of store.all<{id:string}>('SELECT id FROM resources WHERE id NOT IN (SELECT resource_id FROM resource_search)'))indexResource(store,r.id);}
export async function rebuildSearch(store:Store,blobs:BlobStore){
 let indexed=0,html=0;for(const r of store.all<{id:string;html_blob:string|null}>('SELECT id,html_blob FROM resources')){
  let body:string|undefined;
  if(r.html_blob){body=htmlText(Buffer.from(await blobs.get(r.html_blob)).toString('utf8'));html++;}
  indexResource(store,r.id,body);indexed++;
 }return {indexed,html};
}
export function eventChoice(store:Store,event:string|null,scope:string|null,previous?:{event:string|null;event_scope_id?:string|null}){
 const mapped=event?({'common':'共通','共通':'共通','全社共通':'共通','jopt':'JOPT','spadie':'SPADIE','u-30':'U-30','u30':'U-30','戦国':'戦国','战国':'戦国'} as Record<string,string>)[normalizeText(event)]??event:null;
 if(mapped&&!store.one('SELECT name FROM event_series WHERE name=?',mapped)&&mapped!==previous?.event)throw new HTTPException(400,{message:'大会は一覧から選択してください。'});
 if(scope&&!store.one('SELECT id FROM event_scopes WHERE id=? AND event=?',scope,mapped))throw new HTTPException(400,{message:'開催地・季節と大会の組み合わせを確認してください。'});
 return {event:mapped,scope};
}
