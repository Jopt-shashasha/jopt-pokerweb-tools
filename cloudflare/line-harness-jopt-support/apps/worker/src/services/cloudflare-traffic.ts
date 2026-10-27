export type TrafficPeriod = '24h' | '7d';
export interface TrafficConfig { account: string; worker: string; token: string }
export interface TrafficPoint { time: string; requests: number; errors: number; subrequests: number }
export interface TrafficData {
  worker: string; period: TrafficPeriod; from: string; to: string; fetchedAt: string;
  totals: { requests: number; errors: number; subrequests: number; errorRate: number; cpuP50Ms: number | null; cpuP99Ms: number | null };
  series: TrafficPoint[];
}
export class TrafficError extends Error {
  constructor(public code: 'permission' | 'upstream', public reason = 'response_shape') { super(code); }
}
const query = `query HarnessTraffic($account: string, $worker: string, $from: string, $to: string) {
  viewer { accounts(filter: {accountTag: $account}) {
    totals: workersInvocationsAdaptive(limit: 1, filter: {scriptName: $worker, datetime_geq: $from, datetime_lt: $to}) {
      sum { requests errors subrequests }
      quantiles { cpuTimeP50 cpuTimeP99 }
    }
    series: workersInvocationsAdaptive(limit: 200, orderBy: [datetimeHour_ASC], filter: {scriptName: $worker, datetime_geq: $from, datetime_lt: $to}) {
      dimensions { datetimeHour }
      sum { requests errors subrequests }
    }
  } }
}`;
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TrafficError('upstream');
  return value;
}
function sum(row: any) {
  return { requests: count(row?.sum?.requests), errors: count(row?.sum?.errors), subrequests: count(row?.sum?.subrequests) };
}
function milliseconds(value: unknown): number | null {
  return value == null ? null : count(value) / 1000;
}
// A cache per Worker isolate, never a publicly cacheable authenticated response.
// Keep only these two periods; config matching prevents cross-account/credential reuse.
export function createTrafficReader() {
  const cache = new Map<TrafficPeriod, { config: TrafficConfig; until: number; data: TrafficData }>();
  const pending = new Map<string, Promise<TrafficData>>();
  return async (config: TrafficConfig, period: TrafficPeriod): Promise<TrafficData> => {
    const cached = cache.get(period);
    if (cached && cached.until > Date.now() && Object.keys(config).every(k => config[k as keyof TrafficConfig] === cached.config[k as keyof TrafficConfig])) return cached.data;
    const key = JSON.stringify([config.account, config.worker, config.token, period]);
    if (pending.has(key)) return pending.get(key)!;
    const load = async () => {
      const to = new Date().toISOString();
      const from = new Date(Date.parse(to) - (period === '7d' ? 7 : 1) * 86400000).toISOString();
      let response: Response;
      try {
        response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
          method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables: { account: config.account, worker: config.worker, from, to } }),
          signal: AbortSignal.timeout(10000), redirect: 'manual',
        });
      } catch (e) {
        const name = e instanceof Error && ['TypeError','TimeoutError','AbortError'].includes(e.name) ? e.name : 'Error';
        throw new TrafficError('upstream', `network_${name}`);
      }
      if (response.status === 401 || response.status === 403) throw new TrafficError('permission');
      if (!response.ok) throw new TrafficError('upstream', `http_${response.status}`);
      let body: any;
      try { body = await response.json(); } catch { throw new TrafficError('upstream', 'invalid_json'); }
      // GraphQL can return HTTP 200 with errors/partial data; never display that as zero traffic.
      if (body.errors?.length) {
        const message = body.errors.map((e: any) => String(e.message || '')).join(' ');
        if (/authoriz|permission|access denied/i.test(message)) throw new TrafficError('permission', 'graphql_permission');
        throw new TrafficError('upstream', /limit|range|budget/i.test(message) ? 'graphql_limit' : /unknown|pars|syntax/i.test(message) ? 'graphql_schema' : 'graphql_error');
      }
      const accounts = body.data?.viewer?.accounts;
      if (!Array.isArray(accounts) || accounts.length !== 1) throw new TrafficError('permission');
      const account = accounts[0];
      if (!Array.isArray(account.totals) || account.totals.length > 1 || !Array.isArray(account.series) || account.series.length >= 200) throw new TrafficError('upstream');
      if (!account.totals.length && account.series.length) throw new TrafficError('upstream');
      const row = account.totals[0];
      const totals = row ? sum(row) : { requests: 0, errors: 0, subrequests: 0 };
      const rows: TrafficPoint[] = account.series.map((r: any) => {
        const time = r.dimensions?.datetimeHour;
        if (typeof time !== 'string' || !Number.isFinite(Date.parse(time))) throw new TrafficError('upstream');
        return { time, ...sum(r) };
      }).sort((a: TrafficPoint, b: TrafficPoint) => a.time.localeCompare(b.time));
      // Preserve the time axis: missing hourly groups represent no requests,
      // rather than drawing sparse hours beside one another at equal spacing.
      const byHour = new Map(rows.map(r => [Date.parse(r.time), r]));
      if (byHour.size !== rows.length) throw new TrafficError('upstream');
      const series: TrafficPoint[] = [];
      if (rows.length) for (let hour = Math.floor(Date.parse(from) / 3600000) * 3600000; hour < Date.parse(to); hour += 3600000) {
        series.push(byHour.get(hour) || { time: new Date(hour).toISOString(), requests: 0, errors: 0, subrequests: 0 });
      }
      const data: TrafficData = { worker: config.worker, period, from, to, fetchedAt: new Date().toISOString(), series,
        totals: { ...totals, errorRate: totals.requests ? totals.errors / totals.requests * 100 : 0,
          cpuP50Ms: totals.requests ? milliseconds(row?.quantiles?.cpuTimeP50) : null,
          cpuP99Ms: totals.requests ? milliseconds(row?.quantiles?.cpuTimeP99) : null } };
      cache.set(period, { config: { ...config }, until: Date.now() + 60000, data });
      return data;
    };
    const promise = load(); pending.set(key, promise);
    try { return await promise; } finally { pending.delete(key); }
  };
}
