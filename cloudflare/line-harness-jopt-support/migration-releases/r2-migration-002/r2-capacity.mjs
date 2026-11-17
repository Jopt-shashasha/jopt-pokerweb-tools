const HARNESS_R2_CLASS_A = new Set(['ListBuckets','PutBucket','ListObjects','ListObjectsV2','ListBucket','PutObject','CopyObject','CompleteMultipartUpload','CreateMultipartUpload','LifecycleStorageTierTransition','ListMultipartUploads','UploadPart','UploadPartCopy','ListParts','PutBucketEncryption','PutBucketCors','PutBucketLifecycleConfiguration']);
const HARNESS_R2_CLASS_B = new Set(['HeadBucket','HeadObject','GetObject','UsageSummary','GetBucketEncryption','GetBucketLocation','GetBucketCors','GetBucketLifecycleConfiguration']);
const HARNESS_R2_FREE = new Set(['DeleteObject','DeleteObjects','DeleteBucket','AbortMultipartUpload']);
function harnessR2OperationTotals(rows) {
  let classA = 0, classB = 0, unknown = 0, infrequent = 0;
  for (const row of rows) {
    const count = row.sum?.requests;
    if (!Number.isFinite(count) || count < 0) throw new Error('invalid_r2_metric');
    const action = row.dimensions?.actionType;
    const storageClass = String(row.dimensions?.storageClass || '').toLowerCase().replace(/[^a-z]/g, '');
    if (storageClass && storageClass !== 'standard') { infrequent += count; continue; }
    if (HARNESS_R2_CLASS_A.has(action)) classA += count;
    else if (HARNESS_R2_CLASS_B.has(action)) classB += count;
    else if (!HARNESS_R2_FREE.has(action)) unknown += count;
  }
  // Unknown operations must never silently appear as zero free-tier usage.
  return { classA: unknown ? null : classA, classB: unknown ? null : classB, unknown, infrequent };
}
function harnessR2LatestStorage(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const name = row.dimensions?.bucketName;
    const at = Date.parse(row.dimensions?.datetime);
    const value = row.max?.payloadSize;
    if (!name || !Number.isFinite(at) || !Number.isFinite(value) || value < 0) throw new Error('invalid_r2_storage');
    const previous = buckets.get(name);
    if (!previous || previous.at < at) buckets.set(name, { at, value });
  }
  return buckets.size ? [...buckets.values()].reduce((n, item) => n + item.value, 0) : null;
}
const HARNESS_R2_QUERY = `query HarnessR2($account:string!,$from:Time!,$to:Time!,$storageFrom:Time!) {
 viewer { accounts(filter:{accountTag:$account}) {
  operations:r2OperationsAdaptiveGroups(limit:1000,filter:{datetime_geq:$from,datetime_leq:$to}) {
   sum { requests } dimensions { actionType storageClass }
  }
  storage:r2StorageAdaptiveGroups(limit:10000,filter:{datetime_geq:$storageFrom,datetime_leq:$to},orderBy:[datetime_DESC]) {
   max { payloadSize } dimensions { datetime bucketName }
  }
 } }
}`;
function createHarnessR2CapacityReader() {
  let cache;
  return async (env) => {
    const now = Date.now(), fetchedAt = new Date(now).toISOString();
    const key = [env.CF_ANALYTICS_ACCOUNT_ID, env.CF_ANALYTICS_TOKEN, env.R2_BILLING_ANCHOR].join(':');
    if (cache?.key === key && cache.until > now) return cache.value;
    const scope = 'R2 アカウント全体・Standard無料枠（分析値は概算）';
    const base = { scope, fetchedAt, credentialExpiry: env.CF_ANALYTICS_TOKEN_EXPIRES_AT || 'unknown', metrics: [] };
    if (!env.CF_ANALYTICS_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return { ...base, status: 'not_configured' };
    try {
      const cycle = billingWindow(env.R2_BILLING_ANCHOR, new Date(now));
      const from = cycle?.from || new Date(now - 31 * 864e5).toISOString();
      const body = await json('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST', headers: { Authorization: 'Bearer ' + env.CF_ANALYTICS_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: HARNESS_R2_QUERY, variables: { account: env.CF_ANALYTICS_ACCOUNT_ID, from, to: fetchedAt, storageFrom: new Date(now - 864e5).toISOString() } })
      });
      if (body.errors?.length) throw new Error('r2_query_unavailable');
      const accounts = body.data?.viewer?.accounts;
      if (!Array.isArray(accounts) || accounts.length !== 1) throw new Error('r2_scope_unavailable');
      const a = accounts[0];
      if (!Array.isArray(a.operations) || !Array.isArray(a.storage) || a.operations.length >= 1000 || a.storage.length >= 10000) throw new Error('r2_metrics_truncated');
      const totals = harnessR2OperationTotals(a.operations);
      const value = { ...base, status: 'ready', from, to: fetchedAt, billingPeriodConfirmed: !!cycle, unknownOperations: totals.unknown, infrequentOperations: totals.infrequent, metrics: [
        capacityMetric('r2Storage', 'R2 保存容量（最新集計値・目安）', harnessR2LatestStorage(a.storage), 1e10, 'bytes', null),
        capacityMetric('r2ClassA', cycle ? 'R2 今期のA類操作' : 'R2 過去31日のA類操作（参考）', totals.classA, 1e6, 'count', cycle?.to || null),
        capacityMetric('r2ClassB', cycle ? 'R2 今期のB類操作' : 'R2 過去31日のB類操作（参考）', totals.classB, 1e7, 'count', cycle?.to || null)
      ] };
      cache = { key, until: now + 60000, value };
      return value;
    } catch (error) {
      return { ...base, status: error instanceof CapacityFailure ? error.status : 'unavailable' };
    }
  };
}
export { harnessR2OperationTotals, harnessR2LatestStorage, createHarnessR2CapacityReader };
