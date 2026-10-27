import {mkdir,readFile,writeFile,copyFile,cp,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';

const source=fileURLToPath(new URL('../',import.meta.url));
const codexHome=process.env.CODEX_HOME || join(homedir(),'.codex');
const target=join(codexHome,'tools','jopt-faq-codex');
const skillTarget=join(codexHome,'skills','jopt-event-register');
const configPath=join(codexHome,'config.toml');
const command=JSON.stringify(process.execPath), args=JSON.stringify([join(target,'server.mjs')]);
const stanza='[mcp_servers.jopt_faq_events]\ncommand = '+command+'\nargs = '+args+'\n';
let config='';try{config=await readFile(configPath,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
const existing=config.match(/^\[mcp_servers\.jopt_faq_events\][\s\S]*?(?=^\[|$(?![\s\S]))/m);
if(existing && existing[0].trim()!==stanza.trim())throw Error('jopt_faq_events already has a different configuration; no files were changed. Inspect it before replacing.');
const backup=join(codexHome,'backups','jopt-faq-'+Date.now());
await mkdir(backup,{recursive:true});
if(config)await writeFile(join(backup,'config.toml'),config);
try{await access(skillTarget);await cp(skillTarget,join(backup,'skill'),{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}
try{await access(target);await cp(target,join(backup,'server'),{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}
await mkdir(target,{recursive:true});
for(const name of ['server.mjs','package.json'])await copyFile(join(source,name),join(target,name));
await cp(join(source,'shared'),join(target,'shared'),{recursive:true});
await cp(join(source,'skills','jopt-event-register'),skillTarget,{recursive:true});
await mkdir(join(skillTarget,'references'),{recursive:true});
await copyFile(join(source,'shared','rules.json'),join(skillTarget,'references','rules.json'));
if(!existing)await writeFile(configPath,config.trimEnd()+'\n\n'+stanza,{mode:0o600});
console.log(JSON.stringify({installed:true,skill:resolve(skillTarget),mcp_server:resolve(target),config:resolve(configPath),backup:resolve(backup),restart_required:true},null,2));
