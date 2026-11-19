import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { createApp } from './app.js';
import { D1Store } from './d1.js';
import { R2Blobs } from './r2.js';
import { migrateSite } from './sites-migrate-worker.js';
import type { Config } from './model.js';
import setupTemplate from './codex-setup.ps1?raw';
import html from '../public/index.html?raw';
import js from '../public/app.js?raw';
import css from '../public/style.css?raw';

type Env = {
 DB: D1Database;
 BUCKET: R2Bucket;
 APP_ORIGIN?: string;
 GOOGLE_CLIENT_ID?: string;
 GOOGLE_CLIENT_SECRET?: string;
 ALLOWED_GOOGLE_DOMAINS?: string;
 INITIAL_ADMIN_EMAIL?: string;
 NEWS_FEED_URLS?: string;
 SLACK_BOT_TOKEN?: string;
 SLACK_WORKSPACE_URL?: string;
 SLACK_SEND_ENABLED?: string;
 PORTAL_MIGRATION_KEY?: string;
 PORTAL_MIGRATION_SHA256?: string;
};

const assets: Record<string,string> = {'index.html':html,'app.js':js,'style.css':css};
const csv = (value:string) => value.split(',').map(x=>x.trim()).filter(Boolean);

function configFrom(env:Env):Config {
 const origin=new URL(env.APP_ORIGIN??'');
 if(origin.protocol!=='https:'||origin.origin!==env.APP_ORIGIN)throw Error('Set APP_ORIGIN to the HTTPS site origin');
 const newsFeeds=csv(env.NEWS_FEED_URLS??'https://www.ml-bear-times.com/rss/');
 for(const feed of newsFeeds){const url=new URL(feed);if(url.protocol!=='https:'||url.username||url.password)throw Error('NEWS_FEED_URLS must contain trusted HTTPS URLs');}
 return {
  origin:origin.origin,localDev:false,dataDir:'',adminEmail:(env.INITIAL_ADMIN_EMAIL??'xiao.h@japanopenpoker.com').toLowerCase(),
  allowedDomains:csv(env.ALLOWED_GOOGLE_DOMAINS??'japanopenpoker.com,huntersite.jp').map(d=>d.toLowerCase()),
  googleClientId:env.GOOGLE_CLIENT_ID,googleClientSecret:env.GOOGLE_CLIENT_SECRET,newsFeeds,mcpPath:'/portal-mcp',
  slackBotToken:env.SLACK_SEND_ENABLED==='true'?env.SLACK_BOT_TOKEN:undefined,slackWorkspaceUrl:env.SLACK_WORKSPACE_URL
 };
}

export default {
 async fetch(request:Request,env:Env){
  let config:Config;
  try{config=configFrom(env);}catch{return Response.json({error:'Portal origin or runtime settings are missing.'},{status:503});}
  if(!env.DB||!env.BUCKET)return Response.json({error:'Portal storage bindings are missing.'},{status:503});
  const store=new D1Store(env.DB);
  if(new URL(request.url).pathname.startsWith('/_portal-migration/')){
   return migrateSite(request,store,env.BUCKET,config.origin,env.PORTAL_MIGRATION_KEY,env.PORTAL_MIGRATION_SHA256)
    .catch(()=>Response.json({error:'Migration request failed'},{status:500}));
  }
  const {app}=createApp(config,store,new R2Blobs(env.BUCKET),undefined,{setupTemplate,asset:name=>assets[name]});
  return app.fetch(request);
 }
};
