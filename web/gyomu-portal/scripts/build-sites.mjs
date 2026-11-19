import { build } from 'esbuild';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=dirname(fileURLToPath(new URL('../package.json',import.meta.url)));
const dist=join(root,'dist'),hosting=join(dist,'.openai');
const metadata=JSON.parse(await readFile(join(root,'.openai','hosting.json'),'utf8'));
const result=await build({
 entryPoints:[join(root,'src','worker.ts')],outfile:join(dist,'server','index.js'),
 bundle:true,format:'esm',platform:'browser',target:'es2023',minify:true,metafile:true,
 conditions:['workerd','worker','browser'],external:['node:crypto','node:buffer','node:async_hooks'],
 plugins:[{name:'embedded-assets',setup(builder){
  builder.onResolve({filter:/\?raw$/},args=>({path:resolve(args.resolveDir,args.path.slice(0,-4)),namespace:'embedded-assets'}));
  builder.onLoad({filter:/.*/,namespace:'embedded-assets'},async args=>({contents:await readFile(args.path,'utf8'),loader:'text'}));
 }}]
});
const imports=Object.values(result.metafile.outputs).flatMap(file=>file.imports.map(module=>module.path));
if(imports.some(name=>!['node:crypto','node:buffer','node:async_hooks'].includes(name)))throw Error('Unexpected Worker runtime import: '+imports.join(', '));

await mkdir(hosting,{recursive:true});
await writeFile(join(hosting,'hosting.json'),JSON.stringify(metadata,null,2)+'\n');

// Sites consumes a Drizzle journal. Keep migrations/ as the single SQL source.
for(const target of [join(root,'drizzle'),join(hosting,'drizzle')]){
 await mkdir(join(target,'meta'),{recursive:true});
 const entries=[];
 for(const name of (await readdir(join(root,'migrations'))).filter(name=>/^\d+_.+\.sql$/.test(name)).sort()){
  const tag=name.slice(0,-4);
  const sql=await readFile(join(root,'migrations',name),'utf8');
  const statements=sql.split(/;\s*(?:\r?\n|$)/).map(x=>x.trim()).filter(x=>x&&!/^PRAGMA foreign_keys\s*=/i.test(x));
  await writeFile(join(target,name),statements.join(';\n--> statement-breakpoint\n')+';\n');
  entries.push({idx:entries.length,version:'6',when:1794787200000+Number(tag.split('_')[0])*1000,tag,breakpoints:true});
 }
 await writeFile(join(target,'meta','_journal.json'),JSON.stringify({version:'7',dialect:'sqlite',entries},null,2)+'\n');
}
console.log('Built '+join(dist,'server','index.js')+' with D1 migrations.');
