import type { NewsItem } from './news.js';

// A byte cap is explicit and model-independent; it is not an exact token estimate.
export const CONTEXT_MAX_BYTES=6000;
export function compactContext(resources:{items:Record<string,any>[];total:number},news:{items:NewsItem[];stale:boolean;error:string|null}){
 const result={resources:resources.items.slice(0,3).map(r=>({id:r.id,title:String(r.title).slice(0,100),description:String(r.description??'').slice(0,100),department:r.department_name??null,path:`/#/resource/${r.id}`})),total_matches:resources.total,
  news:news.items.slice(0,2).map(n=>({title:n.title.slice(0,120),url:n.url.length<=500?n.url:'/#/news',source:n.source,published_at:n.published_at})),news_stale:news.stale,
  budget:{max_response_bytes:CONTEXT_MAX_BYTES,portal_model_calls:0}};
 while(Buffer.byteLength(JSON.stringify(result))>CONTEXT_MAX_BYTES){if(result.resources.length)result.resources.pop();else if(result.news.length)result.news.pop();else break;}
 return result;
}
