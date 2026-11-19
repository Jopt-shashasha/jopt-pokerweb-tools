import { XMLParser } from 'fast-xml-parser';
import { load } from 'cheerio';
import type { Database } from './database.js';
import { epoch } from './model.js';
export interface NewsItem {title:string;url:string;source:string;published_at:string|null;summary?:string;format?:'story'|'article';source_url?:string;digest_url?:string}
// Temporary editorial scope while feed providers are still under discussion.
// Prefer product changes and usable workflows; do not fill gaps with industry news.
export function isProductNews(item:Pick<NewsItem,'title'|'summary'>){
 const excluded=/調達|融資|投資|capex|株価|株式|時価総額|買収|売上|市場シェア|支出の|利用比率|規制|商務省|輸出|関税|法案|訴訟|提訴|裁判|安全性評価|人員削減|レイオフ|funding|fundrais|investment|valuation|acquisition|lawsuit|regulation|export control|stock price/i;
 if(excluded.test(item.title))return false;
 const text=item.title+' '+(item.summary??'');
 const ai=/AI|LLM|モデル|エージェント|生成|推論|機械学習|ChatGPT|OpenAI|Codex|Claude|Anthropic|Gemini|Grok|Qwen|DeepSeek|Llama|Mistral|Hugging Face|OpenRouter|Copilot|Cursor|Muse|GPT|Fable|Mythos/i;
 const practical=/新モデル|新機能|新ツール|新サービス|リリース|公開|発表|登場|提供開始|正式版|ベータ|アップデート|更新|対応|追加|改善|統合|連携|使い方|活用|手順|ステップ|チュートリアル|無料|値下げ|割引|利用枠|上限|リセット|キャンペーン|ギフト|期間限定|お試し|試用|release|launch|new model|new feature|available|update|integration|how to|tutorial|free|trial|reset|usage limit/i;
 return ai.test(text)&&practical.test(item.title);
}
const list=<T>(value:T|T[]|undefined):T[]=>value===undefined?[]:Array.isArray(value)?value:[value];
const clip=(value:string,size:number)=>value.length>size?value.slice(0,size-1)+'…':value;
const plain=(value:unknown)=>{const $=load(typeof value==='string'?value:'');$('script,style,noscript,iframe,form').remove();return $.text().replace(/\s+/g,' ').trim();};
function safeUrl(value:unknown,base?:string){try{if(typeof value!=='string')return null;const u=new URL(value,base);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}}
export function parseNewsFeed(text:string,feedUrl:string):NewsItem[]{
 const parsed=new XMLParser({ignoreAttributes:false,processEntities:false}).parse(text);
 const channel=parsed.rss?.channel??parsed.feed,source=clip(plain(channel?.title)||new URL(feedUrl).hostname,120);
 return list<any>(channel?.item??channel?.entry).slice(0,20).flatMap(item=>{
  const link=typeof item.link==='string'?item.link:list<any>(item.link).find(l=>!l['@_rel']||l['@_rel']==='alternate')?.['@_href'];
  const url=safeUrl(link,feedUrl),title=plain(item.title);if(!url||!title)return [];
  const date=new Date(item.pubDate??item.published??item.updated??''),published_at=Number.isNaN(date.getTime())?null:date.toISOString();
  const content=item['content:encoded']??item.content?.['#text']??item.content??item.description??item.summary?.['#text']??item.summary??'';
  const $=load(typeof content==='string'?content:'');$('script,style,noscript,iframe,form').remove();
  const stories:NewsItem[]=[];
  $('h3').each((_,node)=>{
   const heading=$(node),headline=plain(heading.text());if(!headline||/^(目次|まとめ|お知らせ|関連リンク|参考|免責)/.test(headline))return;
   const section=heading.nextUntil('h3'),bullets=section.filter('ul').children('li').map((_,li)=>plain($(li).text())).get().filter(Boolean);
   if(!bullets.length)return;
   const article=new URL(url);article.hash=heading.attr('id')??'';
   const sourceUrl=section.filter('blockquote').find('a[href]').map((_,a)=>safeUrl($(a).attr('href'),url)).get().find(Boolean);
   stories.push({title:clip(headline,300),summary:bullets.slice(0,2).map(s=>clip(s,115)).join('\n'),url:article.href,digest_url:url,...(sourceUrl?{source_url:sourceUrl}:{}),source,published_at,format:'story'});
  });
  if(stories.length)return stories;
  // A changed digest format must not silently become another daily-title list.
  if(/ニュースまとめ|daily.*(?:digest|roundup)/i.test(title))return [];
  return [{title:clip(title,300),summary:clip(plain(content),230),url,source,published_at,format:'article' as const}];
 });
}
export class News {
 private inflight?:Promise<{items:NewsItem[];stale:boolean;error:string|null}>;
 // Workers require global fetch to be called with its original receiver.
 constructor(private store:Database,private feeds:string[],private fetcher:typeof fetch=(...args)=>fetch(...args),private clock=epoch){}
 async get(){
  const cached=await this.store.one<{payload:string;fetched_at:number}>('SELECT * FROM news_cache WHERE id=1');
  const raw=cached?JSON.parse(cached.payload) as NewsItem[]:[],items=raw.filter(isProductNews);
  const compatible=!!cached&&raw.every(n=>typeof n.summary==='string'&&['story','article'].includes(n.format??''));
  if(cached&&compatible&&cached.fetched_at>this.clock()-3600){
   if(items.length!==raw.length)await this.store.run('UPDATE news_cache SET payload=? WHERE id=1',JSON.stringify(items));
   return {items,stale:false,error:null};
  }
  if(!this.feeds.length)return {items:[],stale:false,error:'ニュース配信元が未設定です。'};
  return this.inflight??=this.refresh(compatible&&cached?{...cached,payload:JSON.stringify(items)}:undefined).finally(()=>{this.inflight=undefined;});
 }
 private async refresh(cached?:{payload:string;fetched_at:number}){
  try {
   const results=await Promise.allSettled(this.feeds.map(async url=>{
    // Workers (Sites) only support redirect 'follow'/'manual'; 'error' throws. Treat any redirect as a failure.
    const response=await this.fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{accept:'application/rss+xml, application/atom+xml, application/xml'}});
    if(response.status>=300&&response.status<400)throw Error('feed redirected');
    if(!response.ok||!response.body)throw Error('feed unavailable');
    const reader=response.body.getReader();let bytes=0,text='';const decoder=new TextDecoder();
    try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>2*1024*1024){await reader.cancel();throw Error('feed too large');}text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
    return parseNewsFeed(text,url);
   }));
   const seen=new Set<string>();
   if(!results.some(r=>r.status==='fulfilled'))throw Error('feeds unavailable');
   const items=results.flatMap(r=>r.status==='fulfilled'?r.value:[]).filter(isProductNews).sort((a,b)=>(b.published_at??'').localeCompare(a.published_at??'')).filter(item=>{const key=item.title.toLowerCase().replace(/\s+/g,'');if(seen.has(key))return false;seen.add(key);return true;}).slice(0,20);
   await this.store.run('INSERT INTO news_cache VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at',JSON.stringify(items),this.clock());
   return {items,stale:false,error:null};
  }catch{return {items:cached?JSON.parse(cached.payload) as NewsItem[]:[],stale:!!cached,error:'ニュースを更新できませんでした。'};}
 }
}
