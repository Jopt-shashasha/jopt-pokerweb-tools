const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const errors = [];
const raw = fs.readFileSync(path.join(root, 'deployed-worker.multipart'));
if (raw.length !== manifest.multipartBytes || digest(raw) !== manifest.multipartSha256) {
  errors.push('Original multipart package differs from the captured baseline.');
}
const listed = new Set(manifest.files.map(file => file.path));
for (const file of manifest.files) {
  const target = path.resolve(root, 'bundle', file.path);
  if (!target.startsWith(path.resolve(root, 'bundle') + path.sep)) {
    errors.push(`Unsafe manifest path: ${file.path}`);
    continue;
  }
  if (!fs.existsSync(target)) {
    errors.push(`Missing module: ${file.path}`);
    continue;
  }
  const data = fs.readFileSync(target);
  if (data.length !== file.bytes || digest(data) !== file.sha256) {
    errors.push(`Module differs from baseline: ${file.path}`);
  }
}
function inspect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) inspect(full);
    else {
      const relative = path.relative(path.join(root, 'bundle'), full).split(path.sep).join('/');
      if (!listed.has(relative)) errors.push(`Unexpected module: ${relative}`);
    }
  }
}
inspect(path.join(root, 'bundle'));
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`PASS: ${manifest.files.length} deployed modules and original package match SHA-256 baseline.`);
  console.log(`Version: ${manifest.versionId}`);
  console.log('Scope: Worker modules only. Static assets, data and secret values are not included.');
}
