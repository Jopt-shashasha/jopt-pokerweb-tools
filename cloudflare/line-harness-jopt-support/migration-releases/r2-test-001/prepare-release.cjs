const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const here = __dirname;
const canonicalBaseline = path.resolve(here, '../../deployment-baselines/d11cc332');
const baseline = fs.existsSync(canonicalBaseline) ? canonicalBaseline : path.resolve(here, '../../outputs/harness-live-d11cc332-20261117');
const output = path.join(here, 'candidate');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
execFileSync(process.execPath, [path.join(baseline, 'verify-baseline.cjs')], { stdio: 'inherit' });
const entry = 'assets/worker-entry-CyzYNkRe.js';
const original = fs.readFileSync(path.join(baseline, 'bundle', entry), 'utf8');
const oldResolver = `function resolveObjectStorage(env2) {
  if (env2.APPWRITE_ENDPOINT) return new AppwriteObjectStorage(env2);
  if (env2.IMAGES) return env2.IMAGES;
  throw new Error("Object storage is not configured");
}`;
if (original.split(oldResolver).length !== 2) throw new Error('Expected resolver anchor is not unique');
const adapter = fs.readFileSync(path.join(here, 'storage-adapter.mjs'), 'utf8')
  .replace('\nexport { HarnessR2TestStorage };', '');
const resolver = `function resolveObjectStorage(env2) {
  if (env2.APPWRITE_ENDPOINT) {
    const legacy = new AppwriteObjectStorage(env2);
    return env2.IMAGES_R2 ? new HarnessR2TestStorage(env2, legacy) : legacy;
  }
  if (env2.IMAGES) return env2.IMAGES;
  throw new Error("Object storage is not configured");
}`;
const changed = original.replace(oldResolver, adapter + '\n' + resolver);
if (fs.existsSync(output)) throw new Error('Candidate already exists; do not overwrite a release');
fs.cpSync(path.join(baseline, 'bundle'), path.join(output, 'bundle'), { recursive: true });
fs.writeFileSync(path.join(output, 'bundle', entry), changed);
const manifest = {
  release: 'r2-test-001', status: 'PREPARED_NOT_DEPLOYED',
  baseVersion: 'd11cc332-914f-4ddb-9f3c-c8b9f30e1aaa',
  changedModule: entry, baseSha256: hash(original), candidateSha256: hash(changed),
  patch: 'Add private-storage test adapter at the existing resolver; no other live logic changed',
  requiredBinding: 'IMAGES_R2', requiredVariables: ['R2_WRITE_MODE=test', 'R2_TEST_ACCOUNT_ID', 'R2_TEST_LINE_USER_ID'],
  identityConfirmed: false, r2SubscriptionConfirmed: false,
  staticAssets: 'Must retain existing live ASSETS binding; not included in this export',
  productionModified: false,
  deploymentGates: ['Confirm exact personal LINE identity and internal account ID', 'Activate R2 and create private Standard bucket',
    'Copy verified baseline/release to canonical project directory', 'Recheck active version immediately before publishing',
    'Preserve all existing secrets, bindings, assets and triggers', 'Perform bounded D1 recovery/inventory checks',
    'Run actual R2 upload/read/withdrawal and Appwrite-mirror rollback checks']
};
fs.writeFileSync(path.join(output, 'release.json'), JSON.stringify(manifest, null, 2)+'\n');
console.log(JSON.stringify(manifest, null, 2));
