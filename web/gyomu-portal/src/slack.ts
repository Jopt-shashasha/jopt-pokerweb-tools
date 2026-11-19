// Slack紹介（管理者が確認して送信）と週次まとめ。
// - Without SLACK_BOT_TOKEN everything works as a preview; nothing is sent.
// - Only published + company-shared resources are ever posted (re-checked at send time).
// - A channel must be configured and enabled by an admin before anything is sent to it.
// - A timeout or 5xx is recorded as `unknown` and never retried automatically; an admin
//   checks Slack and resolves it, so one introduction is not posted twice.
import { randomUUID } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { commit,isBatchConflict,requireSql,type Database,type Statement } from './database.js';
import { Catalog,auditStatement } from './repository.js';
import { now,type Config,type User } from './model.js';
import { digest as hash } from './blob-store.js';
import type { News,NewsItem } from './news.js';

export const INTRO_WEEKLY_CAP=2;
const CHANNEL=/^[CG][A-Z0-9]{8,12}$/;
const JST=9*3600*1000,DAY=86400*1000;
type Fetch=typeof fetch;
type Channel={id:string;name:string|null};
type Card={label:string;effect:string|null;summary:string;creator:string;url:string};
type PostRow={id:string;text:string;kind:'intro'|'digest';resource_id:string|null;channel_id:string;channel_name:string|null;state:string;slack_ts:string|null;error:string|null;forced:number;period:string|null;created_at:string;actor_id:string|null};

const esc=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const firstParagraph=(s:string)=>s.replace(/^何に使えるか\s*/,'').split(/\n\s*\n/)[0].replace(/\s+/g,' ').trim();
const clip=(s:string,n:number)=>s.length>n?s.slice(0,n-1)+'…':s;

export const departmentChannelInput=z.object({channel_id:z.string().trim().regex(CHANNEL).nullable(),channel_name:z.string().trim().max(80).nullable().optional(),enabled:z.boolean()}).strict();
export const slackSettingsInput=z.object({news_channel_id:z.string().trim().regex(CHANNEL).nullable().optional(),news_channel_name:z.string().trim().max(80).nullable().optional(),news_enabled:z.boolean().optional(),digest_include_news:z.boolean().optional(),test_channel_id:z.string().trim().regex(CHANNEL).nullable().optional(),test_channel_name:z.string().trim().max(80).nullable().optional(),digest_channel_id:z.string().trim().regex(CHANNEL).nullable().optional(),digest_channel_name:z.string().trim().max(80).nullable().optional(),digest_enabled:z.boolean().optional(),link_target:z.enum(['portal','original']).optional()}).strict();
export const introSendInput=z.object({channel_id:z.string().regex(CHANNEL),force:z.boolean().default(false)}).strict();
export const DM_MAX_RECIPIENTS=30,DM_WEEKLY_CAP=3;
export const dmSendInput=z.object({user_ids:z.array(z.string().uuid()).min(1).max(30),force:z.boolean().default(false)}).strict();
export const newsSendInput=z.object({keys:z.array(z.string().regex(/^[a-f0-9]{16}$/)).min(1).max(5),force:z.boolean().default(false)}).strict();
export const digestSendInput=z.object({force:z.boolean().default(false)}).strict();

export class Slack {
 constructor(private store:Database,private config:Config,private catalog:Catalog,private fetchImpl:Fetch=fetch,private clock:()=>number=Date.now,private news?:News){}
 get mode(){return this.config.slackBotToken?'live' as const:'preview' as const;}
 private admin(user:User){if(user.role!=='admin')throw new HTTPException(403,{message:'管理者だけが操作できます。'});}
 private async configuration(){
  const rows=await this.store.all<{key:string;value:string}>("SELECT key,value FROM portal_settings WHERE substr(key,1,6)='slack.'");
  return Object.fromEntries(rows.map(row=>[row.key.slice(6),row.value])) as Record<string,string|undefined>;
 }
 private settingStatement(key:string,value:string|null):Statement{
  if(value===null)return ['DELETE FROM portal_settings WHERE key=?','slack.'+key];
  return ['INSERT INTO portal_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at','slack.'+key,value,now()];
 }
 private revisionGuard(settings:Record<string,string|undefined>){
  return requireSql("(SELECT value FROM portal_settings WHERE key='slack.revision') IS ?",settings.revision??null);
 }
 private shareGuard(view:{id:string;version:number}){
  return requireSql("EXISTS(SELECT 1 FROM resources WHERE id=? AND version=? AND status='published' AND visibility='company')",view.id,view.version);
 }
 private targetChanged='送信先または送信状況が変更されました。プレビューを開き直してください。';
 private get loopback(){const h=new URL(this.config.origin).hostname;return ['127.0.0.1','localhost','[::1]'].includes(h);}
 channelLink(id:string){return this.config.slackWorkspaceUrl?`${this.config.slackWorkspaceUrl.replace(/\/$/,'')}/archives/${id}`:null;}

 async settings(user:User){
  this.admin(user);
  const [departments,s]=await Promise.all([
   this.store.all<{id:string;name:string;slack_channel_id:string|null;slack_channel_name:string|null;slack_enabled:number}>('SELECT id,name,slack_channel_id,slack_channel_name,slack_enabled FROM departments ORDER BY sort_order,name'),
   this.configuration()
  ]);
  const digestId=s.digest_channel_id??null,test=this.testChannel(s);
  return {mode:this.mode,test_channel:test?{...test,link:this.channelLink(test.id)}:null,loopback:this.loopback,workspace_url:this.config.slackWorkspaceUrl??null,link_target:s.link_target??'portal',weekly_cap:INTRO_WEEKLY_CAP,
   news_channel:{id:s.news_channel_id??null,name:s.news_channel_name??null,enabled:s.news_enabled==='1'},digest_include_news:s.digest_include_news==='1',
   digest_channel:{id:digestId,name:s.digest_channel_name??null,enabled:s.digest_enabled==='1',link:digestId?this.channelLink(digestId):null},
   departments:departments.map(d=>({id:d.id,name:d.name,channel_id:d.slack_channel_id,channel_name:d.slack_channel_name,enabled:!!d.slack_enabled,link:d.slack_channel_id?this.channelLink(d.slack_channel_id):null}))};
 }
 async updateDepartment(user:User,id:string,body:unknown){
  this.admin(user);const b=departmentChannelInput.safeParse(body);if(!b.success)throw new HTTPException(400,{message:'チャンネルID（C…）を確認してください。'});
  if(b.data.enabled&&!b.data.channel_id)throw new HTTPException(400,{message:'チャンネルIDを入れてから有効にしてください。'});
  if(!await this.store.one('SELECT id FROM departments WHERE id=?',id))throw new HTTPException(404);
  await commit(this.store,[
   requireSql('EXISTS(SELECT 1 FROM departments WHERE id=?)',id),
   ['UPDATE departments SET slack_channel_id=?,slack_channel_name=?,slack_enabled=? WHERE id=?',b.data.channel_id,b.data.channel_name??null,b.data.enabled?1:0,id],
   this.settingStatement('revision',randomUUID()),
   auditStatement(user.id,'slack-channel-update',null,{department_id:id,...b.data})
  ],this.targetChanged);
  return this.settings(user);
 }
 async updateSettings(user:User,body:unknown){
  this.admin(user);const b=slackSettingsInput.safeParse(body);if(!b.success)throw new HTTPException(400,{message:'入力内容を確認してください。'});
  const d=b.data,old=await this.configuration(),values:Record<string,string|null>={};
  for(const [key,value] of Object.entries(d))values[key]=typeof value==='boolean'?(value?'1':'0'):value;
  for(const key of ['test','digest','news']){
   const id=key+'_channel_id',name=key+'_channel_name',enabled=key+'_enabled';
   const destination=id in values?values[id]:old[id];
   if(values[enabled]==='1'&&!destination)throw new HTTPException(400,{message:key==='news'?'ニュース用チャンネルIDを入れてから有効にしてください。':'まとめ用チャンネルIDを入れてから有効にしてください。'});
   if(!destination&&id in values){values[name]=null;if(key!=='test')values[enabled]='0';}
  }
  values.revision=randomUUID();
  await commit(this.store,[this.revisionGuard(old),...Object.entries(values).map(([key,value])=>this.settingStatement(key,value)),auditStatement(user.id,'slack-settings-update',null,d)],this.targetChanged);
  return this.settings(user);
 }
 private testChannel(s:Record<string,string|undefined>):Channel|null{
  return s.test_channel_id?{id:s.test_channel_id,name:s.test_channel_name??null}:null;
 }
 private async channels(s:Record<string,string|undefined>){
  const test=this.testChannel(s);if(test)return [{...test,department_id:null,label:'テスト'}];
  const rows=await this.store.all<{id:string;name:string;slack_channel_id:string;slack_channel_name:string|null}>('SELECT id,name,slack_channel_id,slack_channel_name FROM departments WHERE slack_enabled=1 AND slack_channel_id IS NOT NULL ORDER BY sort_order,name');
  const list:(Channel&{department_id:string|null;label:string})[]=rows.map(d=>({id:d.slack_channel_id,name:d.slack_channel_name,department_id:d.id,label:d.name}));
  if(s.digest_channel_id&&s.digest_enabled==='1'&&!list.some(c=>c.id===s.digest_channel_id))list.push({id:s.digest_channel_id,name:s.digest_channel_name??null,department_id:null,label:'全社'});
  return list;
 }
 /** Shareable resource as seen by an anonymous company member; throws if not shareable now. */
 private async shareable(id:string,user:User){
  const r=await this.catalog.get(id,user);
  if(r.status!=='published'||r.visibility!=='company')throw new HTTPException(409,{message:'社内共有中の資料だけを紹介できます。'});
  return this.catalog.view(r,user);
 }
 private link(view:{id:string;url:string|null},linkTarget:string|undefined,postId?:string){
  if(linkTarget==='original'&&view.url)return view.url;
  return `${this.config.origin}/go/${view.id}`+(postId?`?p=${postId}`:'');
 }
 private card(view:Awaited<ReturnType<Slack['shareable']>>,linkTarget:string|undefined,postId?:string):Card{
  const summary=clip(firstParagraph(view.reader_guide?.summary||view.description||''),140)||'用途はポータルで確認できます。';
  const label=view.headline?.label??(view.department_name?`${view.department_name}向け｜${view.title}`:view.title);
  return {label,effect:view.headline?.effect??null,summary,creator:view.creator_name??'',url:this.link(view,linkTarget,postId)};
 }
 private introMessage(c:Card){
  const body=`*📌 ${esc(c.label)}*`+(c.effect?`\n⏱ ${esc(c.effect)}`:'')+`\n${esc(c.summary)}`;
  return {text:`📌 ${c.label}${c.effect?' — '+c.effect:''}`,blocks:[
   {type:'section',text:{type:'mrkdwn',text:body}},
   {type:'context',elements:[{type:'mrkdwn',text:`作成：${esc(c.creator)}さん`}]},
   {type:'actions',elements:[{type:'button',text:{type:'plain_text',text:'使い方を見る'},url:c.url}]}]};
 }
 private recent(channelId:string,kind:'intro'|'digest',sinceMs:number){
  return this.store.all<PostRow>("SELECT * FROM slack_posts WHERE channel_id=? AND kind=? AND recipient_user_id IS NULL AND state IN ('sending','sent','unknown') AND created_at>=? ORDER BY created_at DESC",channelId,kind,new Date(sinceMs).toISOString());
 }
 private async checks(view:{id:string},channelId:string,s:Record<string,string|undefined>){
  const blockers:string[]=[],warnings:string[]=[];
  const dup=await this.store.one<{created_at:string;state:string}>("SELECT created_at,state FROM slack_posts WHERE kind='intro' AND recipient_user_id IS NULL AND resource_id=? AND channel_id=? AND state IN ('sending','sent','unknown') ORDER BY created_at DESC",view.id,channelId);
  if(dup)blockers.push(dup.state!=='sent'?'このチャンネルへの送信結果が未確認です。Slackを確認して送信履歴で結果を確定してください。':`このチャンネルでは紹介済みです（${dup.created_at.slice(0,10)}）。`);
  const week=(await this.recent(channelId,'intro',this.clock()-7*DAY)).length;
  if(week>=INTRO_WEEKLY_CAP)blockers.push(`このチャンネルは直近7日で${week}件紹介済みです（上限${INTRO_WEEKLY_CAP}件）。週次まとめに回すことをおすすめします。`);
  if(this.testChannel(s)){warnings.push(...blockers.filter(x=>!x.includes('未確認')).map(x=>'（テスト中のため送信できます）'+x));blockers.splice(0,blockers.length,...blockers.filter(x=>x.includes('未確認')));warnings.unshift('テストモード：送信はすべてテスト用チャンネルに届きます。部署のチャンネルには送られません。');}
  else if(this.loopback&&s.link_target!=='original')warnings.push('ポータルが127.0.0.1で動いているため、同僚は「使い方を見る」を開けません（公開後は表示されません）。');
  if(this.mode==='preview')warnings.push('SLACK_BOT_TOKENが未設定のため、プレビューのみです。送信はできません。');
  return {blockers,warnings};
 }
 async introPreview(user:User,id:string,channelId?:string){
  this.admin(user);const s=await this.configuration(),view=await this.shareable(id,user),channels=await this.channels(s);
  const channel=channels.find(c=>c.id===channelId)??(this.testChannel(s)?channels[0]:channels.find(c=>c.department_id&&c.department_id===view.department_id))??null;
  const card=this.card(view,s.link_target),message=this.introMessage(card);
  const {blockers,warnings}=channel?await this.checks(view,channel.id,s):{blockers:['送信先チャンネルが設定されていません。Slack設定で部署のチャンネルを有効にしてください。'],warnings:[] as string[]};
  return {mode:this.mode,resource_id:view.id,channel:channel?{...channel,link:this.channelLink(channel.id)}:null,channels:channels.map(c=>({...c,link:this.channelLink(c.id)})),card,message,blockers,warnings,can_send:this.mode==='live'&&!!channel,has_impact:!!view.headline};
 }
 async introSend(user:User,id:string,body:unknown){
  this.admin(user);const b=introSendInput.safeParse(body);if(!b.success)throw new HTTPException(400,{message:'送信先を確認してください。'});
  if(this.mode!=='live')throw new HTTPException(503,{message:'SLACK_BOT_TOKENが未設定です。現在はプレビューのみです。'});
  const s=await this.configuration(),channel=(await this.channels(s)).find(c=>c.id===b.data.channel_id);if(!channel)throw new HTTPException(400,{message:'有効になっていないチャンネルには送信できません。'});
  const view=await this.shareable(id,user);
  const postId=randomUUID(),date=now();
  const {blockers}=await this.checks(view,channel.id,s);
  if(blockers.some(m=>m.includes('未確認'))||(blockers.length&&!b.data.force))throw new HTTPException(409,{message:blockers.join(' ')});
  const overridable=b.data.force||!!this.testChannel(s);
  const states=overridable?"'sending','unknown'":"'sending','sent','unknown'";
  const guard=requireSql("NOT EXISTS(SELECT 1 FROM slack_posts WHERE kind='intro' AND recipient_user_id IS NULL AND resource_id=? AND channel_id=? AND state IN ("+states+"))",view.id,channel.id);
  const cap=requireSql("(SELECT COUNT(*) FROM slack_posts WHERE channel_id=? AND kind='intro' AND recipient_user_id IS NULL AND state IN ('sending','sent','unknown') AND created_at>=?)<?",channel.id,new Date(this.clock()-7*DAY).toISOString(),INTRO_WEEKLY_CAP);
  const message=this.introMessage(this.card(view,s.link_target,postId));
  await commit(this.store,[
   this.revisionGuard(s),this.shareGuard(view),guard,...(overridable?[]:[cap]),
   ["INSERT INTO slack_posts(id,kind,resource_id,resource_ids,channel_id,channel_name,text,state,forced,actor_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'sending',?,?,?,?)",postId,'intro',view.id,JSON.stringify([view.id]),channel.id,channel.name,message.text,b.data.force?1:0,user.id,date,date]
  ],this.targetChanged);
  return this.deliver(postId,channel.id,message,user);
 }
 /** ok / failed (Slack said no: nothing happened) / unknown (timeout, 5xx: may or may not have happened). */
 private async api(method:string,params:Record<string,unknown>,form=false):Promise<{kind:'ok';data:any}|{kind:'failed'|'unknown';error:string}>{
  try{
   const res=await this.fetchImpl('https://slack.com/api/'+method,{method:'POST',signal:AbortSignal.timeout(10000),headers:{'content-type':form?'application/x-www-form-urlencoded':'application/json; charset=utf-8',authorization:'Bearer '+this.config.slackBotToken},body:form?new URLSearchParams(params as Record<string,string>).toString():JSON.stringify(params)});
   if(res.status>=500)return {kind:'unknown',error:`Slack HTTP ${res.status}`};
   const data=await res.json() as {ok?:boolean;error?:string};return data.ok?{kind:'ok',data}:{kind:'failed',error:data.error??`HTTP ${res.status}`};
  }catch(e){return {kind:'unknown',error:e instanceof Error?e.name+': '+e.message:'network error'};}
 }
 private async deliver(postId:string,channelId:string,message:{text:string;blocks:unknown[]},user:User,table:'slack_posts'|'news_posts'='slack_posts'){
  let state:'sent'|'failed'|'unknown',ts:string|null=null,error:string|null=null;
  const r=await this.api('chat.postMessage',{channel:channelId,text:message.text,blocks:message.blocks,unfurl_links:false,unfurl_media:false});
  if(r.kind==='ok'){state='sent';ts=r.data.ts??null;}else{state=r.kind;error=r.error;}
  await this.store.run(`UPDATE ${table} SET state=?,slack_ts=?,error=?,updated_at=? WHERE id=? AND state='sending'`,state,ts,error,now(),postId);
  await this.catalog.audit(user.id,'slack-post',null,{post_id:postId,channel_id:channelId,state,error});
  return {post_id:postId,state,error,message:state==='sent'?'Slackに送信しました。':state==='failed'?'Slackが送信を拒否しました：'+error:'送信結果を確認できませんでした。Slackを確認して、送信履歴で結果を確定してください（自動では再送しません）。'};
 }
 /** The 7 full JST days before today. */
 period(){
  const today=Math.floor((this.clock()+JST)/DAY)*DAY-JST,start=today-7*DAY;
  const d=(ms:number)=>new Date(ms+JST).toISOString().slice(5,10).replace('-','/');
  return {start:new Date(start).toISOString(),end:new Date(today).toISOString(),key:new Date(start+JST).toISOString().slice(0,10),label:`${d(start)}〜${d(today-DAY)}`};
 }
 private async digestContent(user:User,linkTarget:string|undefined,postId?:string,newsItems:NewsItem[]=[]){
  const p=this.period();
  const ids=await this.store.all<{id:string}>("SELECT id FROM resources WHERE status='published' AND visibility='company' AND created_at>=? AND created_at<? ORDER BY created_at DESC LIMIT 5",p.start,p.end);
  const fresh=await Promise.all(ids.map(async r=>this.catalog.view(await this.catalog.get(r.id,user),user)));
  const startSec=Math.floor(Date.parse(p.start)/1000),endSec=Math.floor(Date.parse(p.end)/1000);
  const top=await this.store.one<{id:string;n:number}>(`SELECT r.id,(SELECT COUNT(*) FROM resource_usage u WHERE u.resource_id=r.id AND u.action='read' AND u.created_at>=? AND u.created_at<?)+(SELECT COUNT(*) FROM link_clicks c WHERE c.resource_id=r.id AND c.created_at>=? AND c.created_at<?) n
   FROM resources r WHERE r.status='published' AND r.visibility='company' ORDER BY n DESC,r.updated_at DESC LIMIT 1`,startSec,endSec,p.start,p.end);
  const popular=top&&top.n>0?{...this.catalog.view(await this.catalog.get(top.id,user),user),reads:top.n}:null;
  const line=(v:(typeof fresh)[number])=>{const c=this.card(v,linkTarget,postId);return {label:c.label,effect:c.effect,url:c.url,id:v.id,version:v.version};};
  const news=newsItems.filter(n=>n.published_at&&n.published_at>=p.start&&n.published_at<p.end).slice(0,3).map(n=>this.newsLine(n));
  return {period:p,items:fresh.map(line),popular:popular?{...line(popular),reads:popular.reads}:null,news};
 }
 private digestMessage(c:Awaited<ReturnType<Slack['digestContent']>>){
  const item=(x:{label:string;effect:string|null;url:string})=>`• <${x.url}|${esc(x.label)}>`+(x.effect?`\n   ⏱ ${esc(x.effect)}`:'');
  const blocks:unknown[]=[{type:'section',text:{type:'mrkdwn',text:`*📚 今週の新しい資料・ツール*（${c.period.label}）\n`+(c.items.length?c.items.map(item).join('\n'):'今週の新着はありません。')}}];
  if(c.popular)blocks.push({type:'section',text:{type:'mrkdwn',text:`*👀 よく見られた資料*\n${item(c.popular)}`}});
  if(c.news.length)blocks.push({type:'section',text:{type:'mrkdwn',text:'*📰 今週のAIニュース*\n'+c.news.map(n=>`• <${n.url}|${esc(n.title)}>  _${esc(n.source)}_`).join('\n')}});
  blocks.push({type:'context',elements:[{type:'mrkdwn',text:'業務ポータル'}]});
  return {text:`今週の新しい資料・ツール（${c.period.label}）${c.items.length}件`,blocks};
 }
 private digestTarget(s:Record<string,string|undefined>){
  const test=this.testChannel(s);if(test)return {...test,enabled:true,test:true};
  return s.digest_channel_id?{id:s.digest_channel_id,name:s.digest_channel_name??null,enabled:s.digest_enabled==='1',test:false}:null;
 }
 private async digestNews(s:Record<string,string|undefined>){
  return s.digest_include_news==='1'&&this.news?(await this.news.get()).items:[];
 }
 async digestPreview(user:User){
  this.admin(user);
  const s=await this.configuration(),content=await this.digestContent(user,s.link_target,undefined,await this.digestNews(s));
  const target=this.digestTarget(s),digest=target?.id??null,enabled=!!target?.enabled;
  const blockers:string[]=[],warnings:string[]=[];
  if(!digest||!enabled)blockers.push('まとめ用チャンネルが設定・有効化されていません。');
  if(!content.items.length&&!content.popular&&!content.news.length)blockers.push('対象期間に紹介できる新着がありません。');
  const prior=digest?await this.store.one<{state:string}>("SELECT state FROM slack_posts WHERE kind='digest' AND channel_id=? AND period=? AND state IN ('sending','sent','unknown') ORDER BY state IN ('sending','unknown') DESC,created_at DESC",digest,content.period.key):undefined;
  if(prior){
   const msg=prior.state==='sent'?'この期間のまとめは送信済みです。':'この期間のまとめの送信結果が未確認です。Slackを確認して送信履歴で結果を確定してください。';
   if(target?.test&&prior.state==='sent')warnings.push('（テスト中のため送信できます）'+msg);else blockers.push(msg);
  }
  if(target?.test)warnings.unshift('テストモード：まとめはテスト用チャンネルに届きます。');
  if(!target?.test&&this.loopback&&s.link_target!=='original')warnings.push('ポータルが127.0.0.1で動いているため、同僚はリンクを開けません（公開後は表示されません）。');
  if(this.mode==='preview')warnings.push('SLACK_BOT_TOKENが未設定のため、プレビューのみです。');
  return {mode:this.mode,test:!!target?.test,channel:target?{id:target.id,name:target.name,link:this.channelLink(target.id)}:null,...content,message:this.digestMessage(content),blockers,warnings,can_send:this.mode==='live'&&!!digest&&enabled};
 }
 async digestSend(user:User,body:unknown){
  this.admin(user);const b=digestSendInput.safeParse(body??{});if(!b.success)throw new HTTPException(400);
  if(this.mode!=='live')throw new HTTPException(503,{message:'SLACK_BOT_TOKENが未設定です。現在はプレビューのみです。'});
  const s=await this.configuration(),target=this.digestTarget(s);
  if(!target?.enabled)throw new HTTPException(400,{message:'まとめ用チャンネルが有効ではありません。'});
  const postId=randomUUID(),date=now(),content=await this.digestContent(user,s.link_target,postId,await this.digestNews(s));
  if(!content.items.length&&!content.popular&&!content.news.length)throw new HTTPException(409,{message:'対象期間に紹介できる新着がありません。'});
  const message=this.digestMessage(content),items=[...content.items,...(content.popular?[content.popular]:[])];
  const states=b.data.force||target.test?"'sending','unknown'":"'sending','sent','unknown'";
  await commit(this.store,[
   this.revisionGuard(s),...items.map(item=>this.shareGuard(item)),
   requireSql("NOT EXISTS(SELECT 1 FROM slack_posts WHERE kind='digest' AND channel_id=? AND period=? AND state IN ("+states+"))",target.id,content.period.key),
   ["INSERT INTO slack_posts(id,kind,resource_id,resource_ids,channel_id,channel_name,text,state,period,forced,actor_id,created_at,updated_at) VALUES (?,?,NULL,?,?,?,?,'sending',?,?,?,?,?)",postId,'digest',JSON.stringify(items.map(x=>x.id)),target.id,target.name,message.text,content.period.key,b.data.force?1:0,user.id,date,date]
  ],this.targetChanged);
  return this.deliver(postId,target.id,message,user);
 }
 private newsLine(n:NewsItem){return {key:hash(n.url).slice(0,16),title:clip(n.title,120),url:n.url,source:n.source,published_at:n.published_at,summary:clip((n.summary??'').replace(/\s+/g,' ').trim(),115)};}
 private newsTarget(s:Record<string,string|undefined>){
  const test=this.testChannel(s);if(test)return {...test,test:true};
  return s.news_channel_id&&s.news_enabled==='1'?{id:s.news_channel_id,name:s.news_channel_name??null,test:false}:null;
 }
 private async newsSentState(url:string,channelId:string){
  const row=await this.store.one<{state:string}>("SELECT p.state FROM news_sent n JOIN news_posts p ON p.id=n.post_id WHERE n.url_hash=? AND n.channel_id=? AND p.state IN ('sending','sent','unknown') ORDER BY p.state IN ('sending','unknown') DESC,p.created_at DESC",hash(url),channelId);
  return row?.state??null;
 }
 private newsMessage(items:ReturnType<Slack['newsLine']>[]){
  const fmt=(iso:string|null)=>iso?new Date(Date.parse(iso)+JST).toISOString().slice(5,10).replace('-','/'):'';
  return {text:`📰 AIニュース ${items.length}件：`+items.map(x=>x.title).join(' / '),blocks:[{type:'section',text:{type:'mrkdwn',text:'*📰 AIニュース*'}},
   ...items.map(x=>({type:'section',text:{type:'mrkdwn',text:`*<${x.url}|${esc(x.title)}>*`+(x.summary?`\n${esc(x.summary)}`:'')+`\n_${esc(x.source)}${x.published_at?' · '+fmt(x.published_at):''}_`}})),
   {type:'context',elements:[{type:'mrkdwn',text:'業務ポータル · 全文はリンク先（出典）で読めます'}]}]};
 }
 async newsPreview(user:User){
  this.admin(user);const target=this.newsTarget(await this.configuration()),feed=this.news?await this.news.get():{items:[] as NewsItem[],stale:false,error:'ニュース配信元が未設定です。'};
  const items=await Promise.all(feed.items.slice(0,10).map(async n=>({...this.newsLine(n),sent:target?await this.newsSentState(n.url,target.id):null})));
  const blockers:string[]=[],warnings:string[]=[];
  if(!target)blockers.push('ニュース用チャンネルが設定・有効化されていません。');
  if(target?.test)warnings.push('テストモード：ニュースはテスト用チャンネルに届きます。');
  if(feed.error)warnings.push(feed.error);if(feed.stale)warnings.push('配信元に接続できないため、保存済みのニュースを表示しています。');
  if(this.mode==='preview')warnings.push('SLACK_BOT_TOKENが未設定のため、プレビューのみです。');
  return {mode:this.mode,channel:target?{id:target.id,name:target.name,link:this.channelLink(target.id)}:null,test:!!target?.test,items,blockers,warnings,can_send:this.mode==='live'&&!!target};
 }
 async newsSend(user:User,body:unknown){
  this.admin(user);const b=newsSendInput.safeParse(body);if(!b.success)throw new HTTPException(400,{message:'送るニュースを1〜5件選んでください。'});
  if(this.mode!=='live')throw new HTTPException(503,{message:'SLACK_BOT_TOKENが未設定です。現在はプレビューのみです。'});
  const s=await this.configuration(),target=this.newsTarget(s);if(!target)throw new HTTPException(400,{message:'ニュース用チャンネルが有効ではありません。'});
  // Only items from the current feed can be sent; no free-form URLs.
  const feed=(await this.news!.get()).items.map(n=>this.newsLine(n)),chosen=[...new Set(b.data.keys)].map(k=>feed.find(n=>n.key===k));
  if(chosen.some(x=>!x))throw new HTTPException(409,{message:'ニュースが更新されました。もう一度プレビューしてください。'});
  const items=chosen as ReturnType<Slack['newsLine']>[],postId=randomUUID(),date=now(),message=this.newsMessage(items);
  const states=b.data.force||target.test?"'sending','unknown'":"'sending','sent','unknown'";
  const keys=items.map(x=>hash(x.url));
  await commit(this.store,[
   this.revisionGuard(s),
   requireSql("NOT EXISTS(SELECT 1 FROM news_sent n JOIN news_posts p ON p.id=n.post_id WHERE n.channel_id=? AND n.url_hash IN (SELECT value FROM json_each(?)) AND p.state IN ("+states+"))",target.id,JSON.stringify(keys)),
   ["INSERT INTO news_posts(id,channel_id,channel_name,text,state,forced,actor_id,created_at,updated_at) VALUES (?,?,?,?,'sending',?,?,?,?)",postId,target.id,target.name,message.text,b.data.force?1:0,user.id,date,date],
   ...items.map((x,i):Statement=>['INSERT INTO news_sent(post_id,url_hash,channel_id,url,title) VALUES (?,?,?,?,?)',postId,keys[i],target.id,x.url,x.title])
  ],this.targetChanged);
  return this.deliver(postId,target.id,message,user,'news_posts');
 }
 /** Active employees an admin can DM (Slack IDs are matched by company email when sending). */
 async people(user:User){
  this.admin(user);
  return {items:(await this.store.all<{id:string;name:string;email:string;department_id:string|null;department_name:string|null;slack_user_id:string|null}>('SELECT u.id,u.name,u.email,u.department_id,d.name department_name,u.slack_user_id FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.active=1 ORDER BY d.sort_order,u.name'))
   .map(u=>({...u,slack_linked:!!u.slack_user_id,slack_user_id:undefined}))};
 }
 private dmGuard(resourceId:string,recipient:string,force:boolean){
  const duplicate="SELECT 1 FROM slack_posts WHERE kind='intro' AND resource_id=? AND recipient_user_id=? AND state IN ("+(force?"'sending','unknown'":"'sending','sent','unknown'")+")";
  if(force)return requireSql('NOT EXISTS('+duplicate+')',resourceId,recipient);
  const cap="SELECT COUNT(*) FROM slack_posts WHERE kind='intro' AND recipient_user_id=? AND state IN ('sending','sent','unknown') AND created_at>=?";
  return requireSql('NOT EXISTS('+duplicate+') AND ('+cap+')<?',resourceId,recipient,recipient,new Date(this.clock()-7*DAY).toISOString(),DM_WEEKLY_CAP);
 }
 private async slackUserId(person:{id:string;email:string;slack_user_id:string|null}){
  if(person.slack_user_id)return {kind:'ok' as const,id:person.slack_user_id};
  const r=await this.api('users.lookupByEmail',{email:person.email},true);
  if(r.kind!=='ok')return {kind:'failed' as const,error:r.error==='users_not_found'?'Slackでこのメールのユーザーが見つかりません':r.error};
  const id=String(r.data.user?.id??'');if(!/^[UW][A-Z0-9]{6,}$/.test(id))return {kind:'failed' as const,error:'invalid user id'};
  await this.store.run('UPDATE users SET slack_user_id=? WHERE id=?',id,person.id);return {kind:'ok' as const,id};
 }
 async introDm(user:User,resourceId:string,body:unknown){
  this.admin(user);const b=dmSendInput.safeParse(body);if(!b.success)throw new HTTPException(400,{message:`宛先を1〜${DM_MAX_RECIPIENTS}人選んでください。`});
  if(this.mode!=='live')throw new HTTPException(503,{message:'SLACK_BOT_TOKENが未設定です。現在はプレビューのみです。'});
  const [view,s]=await Promise.all([this.shareable(resourceId,user),this.configuration()]),ids=[...new Set(b.data.user_ids)];
  const people=await this.store.all<{id:string;name:string;email:string;slack_user_id:string|null}>('SELECT id,name,email,slack_user_id FROM users WHERE id IN (SELECT value FROM json_each(?)) AND active=1',JSON.stringify(ids));
  people.sort((a,b)=>ids.indexOf(a.id)-ids.indexOf(b.id));
  if(people.length!==ids.length)throw new HTTPException(400,{message:'無効なユーザーが含まれています。'});
  const test=this.testChannel(s);
  if(test){
   // Test mode: one message to the test channel listing who would receive the DM.
   const postId=randomUUID(),date=now(),card=this.introMessage(this.card(view,s.link_target,postId));
   const message={text:card.text,blocks:[{type:'context',elements:[{type:'mrkdwn',text:`🧪 テスト：本番では次の人にDMします → ${esc(people.map(p=>p!.name).join('、'))}`}]},...card.blocks]};
   await commit(this.store,[this.revisionGuard(s),this.shareGuard(view),["INSERT INTO slack_posts(id,kind,resource_id,resource_ids,channel_id,channel_name,text,state,forced,actor_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'sending',0,?,?,?)",postId,'intro',view.id,JSON.stringify([view.id]),test.id,test.name,'[DMテスト] '+card.text,user.id,date,date]],this.targetChanged);
   const r=await this.deliver(postId,test.id,message,user);
   return {test:true,results:[{name:'テスト用チャンネル',state:r.state,message:r.message}],summary:r.message};
  }
  const results:{user_id:string;name:string;state:string;message:string}[]=[];
  for(const person of people){
   const postId=randomUUID(),date=now(),card=this.introMessage(this.card(view,s.link_target,postId));
   try{
    await this.store.batch([
     this.revisionGuard(s),this.shareGuard(view),
     requireSql('EXISTS(SELECT 1 FROM users WHERE id=? AND active=1)',person.id),
     this.dmGuard(view.id,person.id,b.data.force),
     ["INSERT INTO slack_posts(id,kind,resource_id,resource_ids,channel_id,channel_name,text,state,forced,actor_id,recipient_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'sending',?,?,?,?,?)",postId,'intro',view.id,JSON.stringify([view.id]),'pending','DM: '+person.name,card.text,b.data.force?1:0,user.id,person.id,date,date]
    ]);
   }catch(error){
    if(!isBatchConflict(error))throw error;
    results.push({user_id:person.id,name:person.name,state:'skipped',message:'送信条件が変わったか、送信済み・上限・結果未確認のため送りません。'});
    continue;
   }
   const fail=async(error:string)=>{
    await this.store.run("UPDATE slack_posts SET state='failed',error=?,updated_at=? WHERE id=? AND state='sending'",error,now(),postId);
    results.push({user_id:person.id,name:person.name,state:'failed',message:error});
   };
   const sid=await this.slackUserId(person);if(sid.kind!=='ok'){await fail(sid.error);continue;}
   const im=await this.api('conversations.open',{users:sid.id});if(im.kind!=='ok'){await fail(im.error);continue;}
   const dm=String(im.data.channel?.id??'');if(!/^D[A-Z0-9]{6,}$/.test(dm)){await fail('invalid DM channel');continue;}
   try{
    await this.store.batch([this.revisionGuard(s),this.shareGuard(view),
     requireSql("EXISTS(SELECT 1 FROM slack_posts WHERE id=? AND state='sending') AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1)",postId,person.id),
     ['UPDATE slack_posts SET channel_id=? WHERE id=?',dm,postId]]);
   }catch(error){
    if(!isBatchConflict(error))throw error;
    await fail(this.targetChanged);continue;
   }
   const r=await this.deliver(postId,dm,card,user);results.push({user_id:person.id,name:person.name,state:r.state,message:r.message});
  }
  const count=(st:string)=>results.filter(r=>r.state===st).length;
  return {test:false,results,summary:`送信 ${count('sent')}人・スキップ ${count('skipped')}人・失敗 ${count('failed')}人`+(count('unknown')?`・結果未確認 ${count('unknown')}人`:'')};
 }
 async posts(user:User){
  this.admin(user);
  return {items:(await this.store.all<PostRow&{title:string|null;actor_name:string|null;clicks:number}>(`SELECT p.*,r.title,u.name actor_name,(SELECT COUNT(*) FROM link_clicks c WHERE c.post_id=p.id) clicks FROM slack_posts p LEFT JOIN resources r ON r.id=p.resource_id LEFT JOIN users u ON u.id=p.actor_id ORDER BY p.created_at DESC LIMIT 50`))
   .concat(await this.store.all<any>(`SELECT p.id,'news' kind,(SELECT group_concat(title,' / ') FROM news_sent WHERE post_id=p.id) title,p.text,p.channel_id,p.channel_name,p.state,p.error,p.forced,u.name actor_name,0 clicks,p.created_at FROM news_posts p LEFT JOIN users u ON u.id=p.actor_id ORDER BY p.created_at DESC LIMIT 50`)).sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,50)
   .map(p=>({id:p.id,kind:p.kind,title:p.title,text:p.text,channel_id:p.channel_id,channel_name:p.channel_name,channel_link:this.channelLink(p.channel_id),state:p.state,error:p.error,forced:!!p.forced,actor:p.actor_name,clicks:p.clicks,created_at:p.created_at}))};
 }
 async resolve(user:User,id:string,body:unknown){
  this.admin(user);const b=z.object({outcome:z.enum(['sent','failed'])}).strict().safeParse(body);if(!b.success)throw new HTTPException(400);
  const staleAt=new Date(Date.now()-60000).toISOString();
  let r=await this.store.run("UPDATE slack_posts SET state=?,resolved_by=?,updated_at=? WHERE id=? AND (state='unknown' OR (state='sending' AND updated_at<=?))",b.data.outcome,user.id,now(),id,staleAt);
  if(!r.changes)r=await this.store.run("UPDATE news_posts SET state=?,resolved_by=?,updated_at=? WHERE id=? AND (state='unknown' OR (state='sending' AND updated_at<=?))",b.data.outcome,user.id,now(),id,staleAt);
  if(!r.changes)throw new HTTPException(409,{message:'未確認の送信ではありません。'});
  await this.catalog.audit(user.id,'slack-post-resolve',null,{post_id:id,outcome:b.data.outcome});return {ok:true};
 }
 /** Records a human click and returns where to send the browser: always the portal detail page. */
 async click(resourceId:string,postId:string|undefined,user:User|null,userAgent:string|undefined){
  if(!await this.store.one("SELECT id FROM resources WHERE id=? AND ((status='published' AND visibility='company') OR creator_id=? OR ?='admin')",resourceId,user?.id??null,user?.role??null))throw new HTTPException(404);
  const bot=!userAgent||/bot|slack|crawler|spider|preview|facebookexternalhit|curl|wget|python|node-fetch/i.test(userAgent);
  if(!bot){
   const post=postId&&/^[0-9a-f-]{36}$/.test(postId)&&await this.store.one('SELECT id FROM slack_posts WHERE id=? AND (resource_id=? OR resource_ids LIKE ?)',postId,resourceId,`%"${resourceId}"%`)?postId:null;
   await this.store.run('INSERT INTO link_clicks(id,resource_id,post_id,user_id,created_at) VALUES (?,?,?,?,?)',randomUUID(),resourceId,post,user?.id??null,now());
  }
  return `/#/resource/${resourceId}`;
 }
}
