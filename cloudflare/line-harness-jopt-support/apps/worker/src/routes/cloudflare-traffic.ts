import { Hono } from 'hono';
import type { Env } from '../index.js';
import { createTrafficReader, TrafficError } from '../services/cloudflare-traffic.js';

import { createCapacityReader } from '../services/service-capacity.js';

export const cloudflareTraffic = new Hono<Env>();
const readTraffic = createTrafficReader();
cloudflareTraffic.get('/api/cloudflare-traffic', async c => {
  c.header('Cache-Control', 'private, no-store');
  const staff = c.get('staff');
  if (!staff) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (staff.role !== 'owner' && staff.role !== 'admin') return c.json({ success: false, error: '管理者権限が必要です' }, 403);
  const period = c.req.query('period') || '24h';
  if (period !== '24h' && period !== '7d') return c.json({ success: false, error: 'periodは24hまたは7dを指定してください' }, 400);
  const account = c.env.CF_ANALYTICS_ACCOUNT_ID, worker = c.env.WORKER_NAME, token = c.env.CF_ANALYTICS_TOKEN;
  if (!account || !worker || !token) return c.json({ success: true, data: { status: 'not_configured' } });
  try {
    const metrics = await readTraffic({ account, worker, token }, period);
    return c.json({ success: true, data: { status: 'ready', ...metrics } });
  } catch (e) {
    if (e instanceof TrafficError) console.warn('[cloudflare-traffic]', e.code, e.reason);
    const status = e instanceof TrafficError && e.code === 'permission' ? 'permission_error' : 'unavailable';
    // Do not return/log raw upstream responses, request headers or credentials.
    return c.json({ success: true, data: { status } });
  }
});

const readCapacity = createCapacityReader();
cloudflareTraffic.get('/api/service-capacity', async c => {
  c.header('Cache-Control','private, no-store');
  const staff=c.get('staff');
  if(!staff)return c.json({success:false,error:'Unauthorized'},401);
  if(staff.role!=='owner'&&staff.role!=='admin')return c.json({success:false,error:'管理者権限が必要です'},403);
  const e=c.env;
  const data=await readCapacity({
    CF_ANALYTICS_TOKEN_EXPIRES_AT:e.CF_ANALYTICS_TOKEN_EXPIRES_AT,APPWRITE_USAGE_KEY_EXPIRES_AT:e.APPWRITE_USAGE_KEY_EXPIRES_AT,
    CF_ANALYTICS_ACCOUNT_ID:e.CF_ANALYTICS_ACCOUNT_ID,CF_ANALYTICS_TOKEN:e.CF_ANALYTICS_TOKEN,CF_CAPACITY_PLAN:e.CF_CAPACITY_PLAN,
    APPWRITE_ENDPOINT:e.APPWRITE_ENDPOINT,APPWRITE_PROJECT_ID:e.APPWRITE_PROJECT_ID,APPWRITE_USAGE_API_KEY:e.APPWRITE_USAGE_API_KEY,
    APPWRITE_BILLING_ANCHOR:e.APPWRITE_BILLING_ANCHOR,APPWRITE_BANDWIDTH_LIMIT_BYTES:e.APPWRITE_BANDWIDTH_LIMIT_BYTES,APPWRITE_STORAGE_LIMIT_BYTES:e.APPWRITE_STORAGE_LIMIT_BYTES,
  });
  return c.json({success:true,data});
});
