import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';
import { cloudflareTraffic } from './cloudflare-traffic.js';
import { createTrafficReader } from '../services/cloudflare-traffic.js';

const config = { account: 'account', worker: 'harness', token: 'private-analytics-token' };
function payload() {
  return { data: { viewer: { accounts: [{
    totals: [{ sum: { requests: 10, errors: 2, subrequests: 15 }, quantiles: { cpuTimeP50: 1250, cpuTimeP99: 9000 } }],
    series: [{ dimensions: { datetimeHour: '2026-10-26T00:00:00Z' }, sum: { requests: 10, errors: 2, subrequests: 15 } }],
  }] } } };
}
function respond(body: unknown = payload(), status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
}
function request(role: 'owner'|'admin'|'staff'|null = 'owner', bindings: Record<string,string> = {}, url = '/api/cloudflare-traffic') {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => { if (role) c.set('staff', { id: 'operator', name: 'Operator', role }); await next(); });
  app.route('/', cloudflareTraffic);
  return app.request(url, {}, bindings as any);
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('Cloudflare traffic access and configuration', () => {
  it('rejects anonymous users and staff before any upstream access', async () => {
    const network = respond();
    expect((await request(null)).status).toBe(401);
    expect((await request('staff')).status).toBe(403);
    expect(network).not.toHaveBeenCalled();
  });
  it('shows missing connection to owner/admin, never fabricated zero metrics', async () => {
    const network = respond();
    for (const role of ['owner','admin'] as const) {
      const res = await request(role);
      expect(await res.json()).toEqual({ success: true, data: { status: 'not_configured' } });
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    }
    expect(network).not.toHaveBeenCalled();
  });
  it('rejects arbitrary time ranges', async () => { expect((await request('owner', {}, '/api/cloudflare-traffic?period=365d')).status).toBe(400); });
  it('returns only metrics and never token/account credentials', async () => {
    respond();
    const res = await request('owner', { CF_ANALYTICS_ACCOUNT_ID: config.account, WORKER_NAME: config.worker, CF_ANALYTICS_TOKEN: config.token });
    const body = await res.json() as any;
    expect(body.data.status).toBe('ready');
    expect(body.data.totals.cpuP50Ms).toBe(1.25);
    expect(JSON.stringify(body)).not.toContain(config.token);
    expect(body.data.account).toBeUndefined();
  });
  it('sanitizes upstream GraphQL errors including echoed credentials', async () => {
    respond({ errors: [{ message: 'sensitive-token-value' }] });
    const res = await request('owner', { CF_ANALYTICS_ACCOUNT_ID: 'other', WORKER_NAME: 'other', CF_ANALYTICS_TOKEN: 'sensitive-token-value' });
    expect(await res.json()).toEqual({ success: true, data: { status: 'unavailable' } });
  });
});
describe('Official Cloudflare aggregate metrics', () => {
  it('uses server scope, rolling UTC bounds, actual overall CPU quantiles and hourly series', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-26T06:00:00Z'));
    const network = respond(); const result = await createTrafficReader()(config, '7d');
    expect(result.from).toBe('2026-10-19T06:00:00.000Z');
    expect(result.totals).toEqual({ requests: 10, errors: 2, subrequests: 15, errorRate: 20, cpuP50Ms: 1.25, cpuP99Ms: 9 });
    const [url, init] = network.mock.calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
    const query = JSON.parse(init!.body as string);
    expect(query.variables).toEqual({ account: config.account, worker: config.worker, from: result.from, to: result.to });
    expect(init!.headers).toMatchObject({ Authorization: `Bearer ${config.token}` });
    expect(init!.redirect).toBe('manual'); expect(init!.signal).toBeDefined();
    expect(query.query).toContain('datetime_lt');
  });
  it('coalesces concurrent calls and expires the cache after 60 seconds', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-26T06:00:00Z'));
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(payload())));
    const read = createTrafficReader();
    const [a,b] = await Promise.all([read(config,'24h'), read(config,'24h')]);
    expect(a).toEqual(b); await read(config,'24h'); expect(network).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-26T06:01:01Z')); await read(config,'24h'); expect(network).toHaveBeenCalledTimes(2);
  });
  it('does not reuse cached metrics across credentials or Worker targets', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(payload())));
    const read = createTrafficReader(); await read(config,'24h'); await read({...config, token:'rotated'},'24h'); await read({...config,worker:'other'},'24h');
    expect(network).toHaveBeenCalledTimes(3);
  });
  it('valid empty data is zero requests with unavailable CPU percentiles', async () => {
    respond({data:{viewer:{accounts:[{totals:[],series:[]}]}}});
    const r = await createTrafficReader()(config,'24h');
    expect(r.totals).toEqual({requests:0,errors:0,subrequests:0,errorRate:0,cpuP50Ms:null,cpuP99Ms:null});
  });
  it.each([301,302,307,401,403,429,500])('HTTP %i is an error rather than zero traffic', async status => {
    respond({}, status); await expect(createTrafficReader()(config,'24h')).rejects.toThrow();
  });
  it('network/timeout failure does not become a zero-traffic snapshot', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout'));
    await expect(createTrafficReader()(config,'24h')).rejects.toThrow('upstream');
  });
  it.each([
    {errors:[{message:'permission denied'}],data:payload().data},
    {data:{viewer:{accounts:[]}}},
    {data:{viewer:{accounts:[{totals:[],series:[{}]}]}}},
    {data:{viewer:{accounts:[{totals:[{sum:{requests:null}}],series:[]}]}}},
  ])('rejects partial/malformed data without fabricating metrics', async body => {
    respond(body); await expect(createTrafficReader()(config,'24h')).rejects.toThrow();
  });
});
