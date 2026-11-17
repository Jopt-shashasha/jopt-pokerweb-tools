/**
 * Encrypted, account-scoped FAQ contact IDs. No route, webhook, feature flag,
 * or production deployment is enabled by this module. The calling code MUST
 * authenticate the LINE event and resolve its account/friend from trusted state.
 * Remembering a customer-supplied ID does not verify ownership of that ID.
 */
type Kind = 'game_id' | 'games_id';
export interface ContactScope { accountId: string; friendId: string }
interface Db { prepare(sql: string): { bind(...args: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<{meta?: {changes?: number}}> } } }
interface Row { ciphertext: Uint8Array | ArrayBuffer | number[]; nonce: Uint8Array | ArrayBuffer | number[]; revision: number; expires_at: number }
const ID=/^[A-Za-z0-9_-]{1,128}$/;
const CASE=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORMAT: Record<Kind,RegExp>={game_id:/^[0-9]{8}$/,games_id:/^[0-9]{4}-[0-9]{4}$/};
const enc=new TextEncoder();
function validateScope(scope:ContactScope){if(!scope||!ID.test(scope.accountId||'')||!ID.test(scope.friendId||''))throw new Error('Invalid contact scope');}
function validateKind(kind:Kind){if(!Object.hasOwn(FORMAT,kind))throw new Error('Invalid ID kind');}
function validateKey(key:Uint8Array){if(!(key instanceof Uint8Array)||key.byteLength!==32)throw new Error('Invalid encryption key');}
function aad(scope:ContactScope,kind:Kind){return enc.encode(JSON.stringify(['faq-contact-id-v1',scope.accountId,scope.friendId,kind]));}
function caseAad(scope:ContactScope,caseId:string,kind:Kind){return enc.encode(JSON.stringify(['faq-case-contact-id-v1',scope.accountId,scope.friendId,caseId,kind]));}
async function cryptoKey(raw:Uint8Array){return crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);}
function bytes(x:Uint8Array|ArrayBuffer|number[]){
  if(Array.isArray(x) && (x.length>128||x.some(n=>!Number.isInteger(n)||n<0||n>255)))throw new Error('Invalid encrypted data');
  return x instanceof Uint8Array?x:new Uint8Array(x);
}

/** Optimistic revisions prevent an old screen overwriting a newer value. */
export async function saveContactId(db:Db,scope:ContactScope,kind:Kind,value:string,key:Uint8Array,
  expectedRevision:number,now:number,expiresAt:number,options?:{preserveExisting?:boolean}):Promise<number|null>{
  validateScope(scope);validateKind(kind);validateKey(key);
  if(typeof value!=='string'||!FORMAT[kind].test(value)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||
     !Number.isSafeInteger(now)||!Number.isSafeInteger(expiresAt)||expiresAt<=now)throw new Error('Invalid contact ID input');
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:aad(scope,kind)},await cryptoKey(key),enc.encode(value));
  // A friend may belong to exactly the resolved LINE account. The check is in
  // the write itself, so a forged scope cannot create an association.
  if(expectedRevision===0){
    const row=await db.prepare(`INSERT INTO faq_contact_ids(account_id,friend_id,kind,ciphertext,nonce,revision,expires_at,updated_at)
        SELECT ?,?,?,?,?,1,?,? FROM friends f JOIN line_accounts a ON a.id=f.line_account_id
        WHERE f.id=? AND f.line_account_id=? AND a.id=?
        ON CONFLICT(account_id,friend_id,kind) DO UPDATE SET ciphertext=excluded.ciphertext,nonce=excluded.nonce,
          revision=faq_contact_ids.revision+1,expires_at=excluded.expires_at,updated_at=excluded.updated_at
        WHERE ?=0 AND faq_contact_ids.expires_at<=? AND faq_contact_ids.updated_at<=?
        RETURNING revision`).bind(scope.accountId,scope.friendId,kind,new Uint8Array(encrypted),nonce,expiresAt,now,scope.friendId,scope.accountId,scope.accountId,options?.preserveExisting?1:0,now,now).first<{revision:number}>();
    return row?.revision??null;
  }
  const result=await db.prepare(`UPDATE faq_contact_ids SET ciphertext=?,nonce=?,revision=revision+1,expires_at=?,updated_at=?
        WHERE account_id=? AND friend_id=? AND kind=? AND revision=?
        AND expires_at>? AND updated_at<=? AND EXISTS(SELECT 1 FROM friends f JOIN line_accounts a ON a.id=f.line_account_id WHERE f.id=? AND f.line_account_id=?)`).bind(
        new Uint8Array(encrypted),nonce,expiresAt,now,scope.accountId,scope.friendId,kind,expectedRevision,now,now,scope.friendId,scope.accountId).run();
  return result.meta?.changes===1?expectedRevision+1:null;
}

export async function readContactId(db:Db,scope:ContactScope,kind:Kind,key:Uint8Array,now:number):Promise<{value:string;revision:number}|null>{
  validateScope(scope);validateKind(kind);validateKey(key);if(!Number.isSafeInteger(now))throw new Error('Invalid time');
  const row=await db.prepare(`SELECT c.ciphertext,c.nonce,c.revision,c.expires_at FROM faq_contact_ids c
    JOIN friends f ON f.id=c.friend_id AND f.line_account_id=c.account_id
    JOIN line_accounts a ON a.id=c.account_id
    WHERE c.account_id=? AND c.friend_id=? AND c.kind=? AND c.expires_at>?`).bind(scope.accountId,scope.friendId,kind,now).first<Row>();
  if(!row)return null;
  try {const raw=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(row.nonce),additionalData:aad(scope,kind)},await cryptoKey(key),bytes(row.ciphertext));
    const value=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(raw);return FORMAT[kind].test(value)?{value,revision:row.revision}:null;
  }catch{return null;}
}

export async function deleteContactId(db:Db,scope:ContactScope,kind:Kind,expectedRevision:number,now:number):Promise<boolean>{
  validateScope(scope);validateKind(kind);if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||!Number.isSafeInteger(now))throw new Error('Invalid revision');
  // Preserve the revision as an empty tombstone, so an old confirmation cannot
  // overwrite a newly registered ID after a delete and re-registration.
  const r=await db.prepare(`UPDATE faq_contact_ids SET ciphertext=X'',nonce=X'',revision=revision+1,expires_at=0,updated_at=?
    WHERE account_id=? AND friend_id=? AND kind=? AND revision=? AND expires_at>? AND updated_at<=?
    AND EXISTS(SELECT 1 FROM friends f WHERE f.id=? AND f.line_account_id=?)`).bind(now,scope.accountId,scope.friendId,kind,expectedRevision,now,now,scope.friendId,scope.accountId).run();
  return r.meta?.changes===1;
}

/** Capture the exact confirmed profile version for an owned, still-open case. */
export async function snapshotCaseContactId(db:Db,scope:ContactScope,caseId:string,kind:Kind,key:Uint8Array,
  expectedRevision:number,now:number):Promise<boolean>{
  validateScope(scope);validateKind(kind);validateKey(key);
  if(!CASE.test(caseId||'')||!Number.isSafeInteger(expectedRevision)||expectedRevision<1||!Number.isSafeInteger(now))throw new Error('Invalid case input');
  const profile=await readContactId(db,scope,kind,key,now);if(!profile||profile.revision!==expectedRevision)return false;
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:caseAad(scope,caseId,kind)},await cryptoKey(key),enc.encode(profile.value));
  const r=await db.prepare(`INSERT OR IGNORE INTO faq_case_contact_ids(case_id,account_id,friend_id,kind,ciphertext,nonce,profile_revision,created_at)
    SELECT c.id,c.account_id,c.friend_id,?,?,?,?,? FROM faq_cases c
    JOIN friends f ON f.id=c.friend_id AND f.line_account_id=c.account_id
    JOIN faq_contact_ids p ON p.account_id=c.account_id AND p.friend_id=c.friend_id AND p.kind=?
    WHERE c.id=? AND c.account_id=? AND c.friend_id=? AND c.status IN ('draft','awaiting_image')
      AND p.revision=? AND p.expires_at>?`).bind(kind,new Uint8Array(encrypted),nonce,expectedRevision,now,kind,caseId,scope.accountId,scope.friendId,expectedRevision,now).run();
  return r.meta?.changes===1;
}

/** Caller must separately authenticate and authorize staff before this function. */
export async function readCaseContactId(db:Db,scope:ContactScope,caseId:string,kind:Kind,key:Uint8Array):Promise<string|null>{
  validateScope(scope);validateKind(kind);validateKey(key);if(!CASE.test(caseId||''))throw new Error('Invalid case input');
  const row=await db.prepare(`SELECT i.ciphertext,i.nonce FROM faq_case_contact_ids i
    JOIN faq_cases c ON c.id=i.case_id AND c.account_id=i.account_id AND c.friend_id=i.friend_id
    JOIN friends f ON f.id=c.friend_id AND f.line_account_id=c.account_id
    WHERE i.case_id=? AND i.account_id=? AND i.friend_id=? AND i.kind=?`).bind(caseId,scope.accountId,scope.friendId,kind).first<Row>();
  if(!row)return null;
  try {const raw=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(row.nonce),additionalData:caseAad(scope,caseId,kind)},await cryptoKey(key),bytes(row.ciphertext));
    const value=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(raw);return FORMAT[kind].test(value)?value:null;
  }catch{return null;}
}

/** Encrypt a submitted ID directly for its immutable case snapshot. */
export async function encryptSubmittedCaseId(scope:ContactScope,caseId:string,kind:Kind,value:string,key:Uint8Array){
  validateScope(scope);validateKind(kind);validateKey(key);
  if(!CASE.test(caseId)||!FORMAT[kind].test(value))throw Error('Invalid contact ID input');
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:caseAad(scope,caseId,kind)},await cryptoKey(key),enc.encode(value)));
  return {nonce,ciphertext};
}
