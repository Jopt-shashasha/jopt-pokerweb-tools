import {readFile} from 'node:fs/promises';
import {deflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';

// Explicit allowlist: no credentials, user configuration, work files or imports.
export const packageFiles=['package.json','server.mjs','README.md','install.ps1','scripts/install.mjs','shared/rules.json','shared/contract.cjs','shared/task.cjs','skills/jopt-event-register/SKILL.md','skills/jopt-event-register/agents/openai.yaml','skills/jopt-event-register/references/rules.json','skills/jopt-event-register/references/workflow.md'];
function crc32(buf){let crc=0xffffffff;for(const byte of buf){crc^=byte;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
export async function makePackage(root){
 const parts=[],directory=[];let offset=0;
 for(const name of packageFiles){
  const raw=await readFile(new URL(name,root)),compressed=deflateRawSync(raw),filename=Buffer.from(name),crc=crc32(raw);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt16LE(0x5d58,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(filename.length,26);
  parts.push(local,filename,compressed);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(8,10);central.writeUInt16LE(0x5d58,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(raw.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(offset,42);directory.push(central,filename);offset+=local.length+filename.length+compressed.length;
 }
 const index=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(packageFiles.length,8);end.writeUInt16LE(packageFiles.length,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);
 const zip=Buffer.concat([...parts,index,end]);return {zip,sha256:createHash('sha256').update(zip).digest('hex')};
}
