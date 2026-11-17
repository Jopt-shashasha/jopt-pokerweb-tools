import { resolve } from 'node:path';
import { Store } from '../src/db.js';
import { LocalBlobs } from '../src/storage.js';
import { importDrop } from '../src/importer.js';
const backup=process.argv[2];if(!backup)throw Error('Usage: npm run import:drop -- <backup-directory> [--production]');
const production=process.argv.includes('--production');const dataDir=resolve(process.env.PORTAL_DATA_DIR??'.local');
if(production&&!process.env.PORTAL_DATA_DIR)throw Error('Production import requires explicit PORTAL_DATA_DIR');
const store=new Store(resolve(dataDir,production?'portal.sqlite':'portal-local.sqlite'));
try{console.log(JSON.stringify(await importDrop(store,new LocalBlobs(resolve(dataDir,'blobs')),backup,resolve(dataDir,'reports')),null,2));}finally{store.close();}
