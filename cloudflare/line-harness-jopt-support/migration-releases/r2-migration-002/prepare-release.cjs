const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const here = __dirname;
const canonicalBase = path.resolve(here, '../../deployment-baselines/745f07b7');
const base = fs.existsSync(canonicalBase) ? canonicalBase : path.resolve(here, '../../outputs/harness-live-745f07b7-20261117');
const checking = process.argv[2] === '--verify';
const candidateName = (checking ? process.argv[3] : process.argv[2]) || 'candidate';
if (!/^candidate(?:-rc[2-9][0-9]*)?$/.test(candidateName)) throw new Error('Invalid candidate directory');
const output = path.join(here, candidateName);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
if (!fs.existsSync(path.join(base, 'manifest.json'))) throw new Error('Fresh deployed baseline 745f07b7 has not been captured');
execFileSync(process.execPath, [path.join(base, 'verify-baseline.cjs')], { stdio: 'inherit' });
if (fs.existsSync(output) && !checking) throw new Error('Do not overwrite a release candidate');
const entry = 'assets/worker-entry-CyzYNkRe.js';
const original = fs.readFileSync(path.join(base, 'bundle', entry), 'utf8');
if (digest(original) !== '5c7640afa08531e70cdc17cef92beea1e24447afeac879776f92133e4de130aa') throw new Error('Unexpected deployed source');
const moduleText = name => fs.readFileSync(path.join(here, name), 'utf8').replace(/^export .*;\r?$/mg, '');
function replaceOnce(text, before, after, label) {
  if (text.split(before).length !== 2) throw new Error('Ambiguous patch: ' + label);
  return text.replace(before, after);
}
let changed = original;
const additions = moduleText('router-methods.mjs') + '\nObject.assign(HarnessR2TestStorage.prototype, harnessR2RouterMethods);\n' +
  moduleText('migration-core.mjs') + '\n' + moduleText('r2-capacity.mjs') + '\nconst readHarnessR2Capacity = createHarnessR2CapacityReader();\n';
changed = replaceOnce(changed, 'function resolveObjectStorage(env2) {', additions + '\nfunction resolveObjectStorage(env2) {', 'storage helpers');
const html = fs.readFileSync(path.join(here, 'migration-console.html'), 'utf8');
changed = replaceOnce(changed, 'const images = new Hono();', 'const images = new Hono();\nconst HARNESS_MIGRATION_HTML = ' + JSON.stringify(html) + ';\n' + moduleText('migration-routes.mjs'), 'owner migration routes');
changed = replaceOnce(changed, 'const [cf, aw] = await Promise.all([cloudflare(env2), appwrite(env2)]);',
  'const [cf, aw, r2] = await Promise.all([cloudflare(env2), appwrite(env2), readHarnessR2Capacity(env2)]);', 'capacity aggregation');
changed = replaceOnce(changed, 'const value = { cloudflare: cf, appwrite: aw };', 'const value = { cloudflare: cf, appwrite: aw, r2 };', 'capacity response');
changed = replaceOnce(changed, 'CF_ANALYTICS_TOKEN_EXPIRES_AT: e.CF_ANALYTICS_TOKEN_EXPIRES_AT,',
  'R2_BILLING_ANCHOR: e.R2_BILLING_ANCHOR,\n    CF_ANALYTICS_TOKEN_EXPIRES_AT: e.CF_ANALYTICS_TOKEN_EXPIRES_AT,', 'optional billing anchor');

// Patch only the exact static chunk read from the current deployed site.
const capacityOriginal = fs.readFileSync(path.join(base, 'capacity-page.js'), 'utf8');
if (digest(capacityOriginal) !== fs.readFileSync(path.join(base, 'capacity-page.sha256'), 'utf8').trim()) throw new Error('Frontend source differs from captured deployment');
let capacity = replaceOnce(capacityOriginal, '["appwrite","cloudflare"].map(e=>', '["r2","appwrite","cloudflare"].filter(e=>t[e]).map(e=>', 'R2 provider card');
capacity = replaceOnce(capacity, '"appwrite"===e?"画像・ファイル：Appwrite":"アプリ・チャット：Cloudflare"',
  '"r2"===e?"画像・ファイル：Cloudflare R2":"appwrite"===e?"画像・ファイル：Appwrite":"アプリ・チャット：Cloudflare"', 'R2 title');
capacity = replaceOnce(capacity, '" ／ 上限 ",i(e.limit,e.unit)', 'e.id.startsWith("r2")?" ／ 無料枠 ":" ／ 上限 ",i(e.limit,e.unit)', 'free allowance label');
capacity = replaceOnce(capacity, 'e.resetAt?"appwriteBandwidth"===e.id?', 'e.resetAt?["appwriteBandwidth","r2ClassA","r2ClassB"].includes(e.id)?', 'monthly reset label');
capacity = replaceOnce(capacity, ':"appwriteBandwidth"===e.id?"結算周期が未確認のため残量は算出しません。"',
  ':["r2ClassA","r2ClassB"].includes(e.id)?"請求期間未確認：過去31日の操作回数を参考表示。":"appwriteBandwidth"===e.id?"結算周期が未確認のため残量は算出しません。"', 'unconfirmed billing period');
capacity = replaceOnce(capacity, '残量と稼働状態は別です。Appwrite Freeは開発活動がない場合に自動停止することがあります。未取得の項目はゼロとして扱いません。',
  '残量と稼働状態は別です。Appwrite Freeは開発活動がない場合に自動停止することがあります。未取得の項目はゼロとして扱いません。R2の無料枠はアカウント共有です。保存量の10GB-monthは日次ピークの期間平均で、上の現在値は目安です。操作回数は公式分析の概算です。無料枠を超えると課金され、自動停止はしません。', 'R2 metering explanation');
const chunksAnchor = 'const joptAdminChunks = ';
const chunksStart = changed.indexOf(chunksAnchor);
const chunksEnd = changed.indexOf('\n', chunksStart);
const chunksLine = changed.slice(chunksStart, chunksEnd);
const chunks = JSON.parse(chunksLine.slice(chunksAnchor.length).replace(/;\s*$/, ''));
const capacityPath = '/console/_next/static/chunks/app/cloudflare-traffic/page-9e0ac0ddb884ed24.js';
if (chunks[capacityPath]) throw new Error('Unexpected existing capacity override');
chunks[capacityPath] = capacity;
changed = replaceOnce(changed, chunksLine, chunksAnchor + JSON.stringify(chunks) + ';', 'deployed chunk override');
changed = replaceOnce(changed, '// Keep the deployed static asset collection intact; serve the two reviewed', '// Keep the deployed static asset collection intact; serve the three reviewed', 'override comment');
if (checking) {
  if (fs.readFileSync(path.join(output, 'bundle', entry), 'utf8') !== changed) throw new Error('Candidate does not reproduce from reviewed inputs');
  if (fs.readFileSync(path.join(output, 'capacity-page.js'), 'utf8') !== capacity) throw new Error('Capacity override does not reproduce');
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'release.json'), 'utf8'));
  if (manifest.candidateSha256 !== digest(changed) || manifest.capacityChunkSha256 !== digest(capacity)) throw new Error('Candidate manifest differs');
  const baseManifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
  for (const file of baseManifest.files) {
    const target = fs.readFileSync(path.join(output, 'bundle', file.path));
    if (file.path !== entry && digest(target) !== file.sha256) throw new Error('Unrelated deployed module changed: ' + file.path);
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: target });
  }
  const parsedChunks = JSON.parse(changed.slice(changed.indexOf(chunksAnchor) + chunksAnchor.length, changed.indexOf('\n', changed.indexOf(chunksAnchor))).replace(/;\s*$/, ''));
  const oldChunks = JSON.parse(original.slice(original.indexOf(chunksAnchor) + chunksAnchor.length, original.indexOf('\n', original.indexOf(chunksAnchor))).replace(/;\s*$/, ''));
  for (const [key, value] of Object.entries(oldChunks)) if (parsedChunks[key] !== value) throw new Error('Existing reviewed frontend override changed');
  execFileSync(process.execPath, ['--check'], { input: capacity });
  console.log('PASS: candidate reproduces exactly; 8 modules parse, 7 untouched, existing frontend overrides preserved.');
  process.exit(0);
}
fs.cpSync(path.join(base, 'bundle'), path.join(output, 'bundle'), { recursive: true });
fs.writeFileSync(path.join(output, 'bundle', entry), changed);
fs.writeFileSync(path.join(output, 'capacity-page.js'), capacity);
const baseManifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
for (const file of baseManifest.files) execFileSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(path.join(output, 'bundle', file.path)) });
execFileSync(process.execPath, ['--check'], { input: capacity });
const manifest = {
  release: 'r2-migration-002', status: 'PREPARED_NOT_DEPLOYED', baseVersion: baseManifest.versionId,
  changedModule: entry, baseSha256: digest(original), candidateSha256: digest(changed),
  capacityChunkPath: capacityPath, capacityChunkBaseSha256: digest(capacityOriginal), capacityChunkSha256: digest(capacity),
  retainedBindings: ['DB', 'TENANT_SCHEDULER', 'ASSETS', 'all existing secrets and ordinary variables'],
  newSecretsRequired: false, d1SchemaChanges: false, webhookChanges: false, sourceObjectsDeleted: false,
  migrationDefaults: { R2_MIGRATION_ENABLED: 'disabled', R2_MIGRATION_READS: 'disabled', R2_WRITE_MODE: 'test' },
  rolloutOrder: ['Archive baseline/release in canonical project', 'Recheck deployed version and all module hashes',
    'Deploy with current personal test only', 'Test FAQ upload and writes-off read compatibility',
    'Enable migration reads then owner-only copying', 'Verify every retained image and exclude unsent/deleted images',
    'Test quota page and global mirror mode', 'Switch new images to R2-only all mode', 'Disable migration writes',
    'Record active version and rollback-compatible configuration']
};
fs.writeFileSync(path.join(output, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
