'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, getCsrfToken } from '@/lib/api'
import { getApiBase } from '@/lib/api-base'

type Group={id:string;name:string;updated_at:string}
type Member={friendId:string;displayName:string;groupId:string;state:'active'|'changed'|'unavailable'}
type Friend={id:string;displayName:string|null;isFollowing:boolean}
type Data={groups:Group[];members:Member[];testActive:boolean;preferredGroupId:string}
const button='rounded-lg border border-gray-300 px-4 py-2 text-sm disabled:opacity-40 hover:bg-gray-50'

export default function TestMenuMembers({accountId,revision}:{accountId:string;revision:string}){
  const [data,setData]=useState<Data|null>(null),[group,setGroup]=useState('')
  const [query,setQuery]=useState(''),[hits,setHits]=useState<Friend[]>([]),[picked,setPicked]=useState<Friend[]>([])
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('')
  const root=`/api/accounts/${encodeURIComponent(accountId)}/faq-test-members`
  const call=useCallback(async<T,>(method='GET',body?:unknown,suffix='')=>{
    const r=await fetch(`${getApiBase()}${root}${suffix}`,{method,credentials:'include',headers:{'Content-Type':'application/json','X-CSRF-Token':getCsrfToken()},...(body===undefined?{}:{body:JSON.stringify(body)})})
    const j=await r.json() as {success:boolean;data:T;error?:string}
    if(!r.ok||!j.success)throw Error(j.error||'処理に失敗しました')
    return j.data
  },[root])
  const load=useCallback(async()=>{const d=await call<Data>();setData(d);setGroup(g=>d.groups.some(x=>x.id===g)?g:d.preferredGroupId)},[call])
  useEffect(()=>{void load().catch(e=>setError(String(e.message)))},[load,revision])
  const run=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');setMessage('');try{await fn()}catch(e){setError(e instanceof Error?e.message:'処理に失敗しました')}finally{setBusy(false)}}
  return <div className="space-y-4 rounded-lg border border-green-200 bg-green-50/40 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">テストメンバー</h3><button type="button" className={button} disabled={busy} onClick={()=>void run(load)}>再読み込み</button></div>
    <p className="text-sm">テストメンバーのLINE表示名を検索して追加すると、そのメンバーのトークだけにテスト用メニューが表示されます。先に公式LINEを友だち追加し、表示名が検索に出ない場合は一度メッセージを送ってください。</p>
    {data&&!data.testActive&&<p className="text-sm text-amber-800">先に上の「このバージョンでテスト開始」を実行してください。</p>}
    {data?.groups.length===0&&<p className="text-sm text-amber-800">テスト用メニューがありません。「リッチメニュー」で faqv1:test のpostbackボタンがあるメニューを公開してください。</p>}
    {!!data?.groups.length&&<label className="block text-sm">表示するテスト用メニュー<select aria-label="表示するテスト用メニュー" className="mt-1 block w-full rounded border bg-white p-2" disabled={busy} value={group} onChange={e=>setGroup(e.target.value)}>{data.groups.map(g=><option key={g.id} value={g.id}>{g.name} ／ {g.id.slice(0,8)}</option>)}</select></label>}
    <div className="flex flex-wrap gap-2"><input aria-label="追加するメンバーのLINE表示名" className="min-w-0 flex-1 rounded border p-2" placeholder="LINEの表示名" value={query} disabled={busy} onChange={e=>setQuery(e.target.value)} /><button type="button" className={button} disabled={busy} onClick={()=>void run(async()=>{const r=await api.friends.list({accountId,search:query,limit:20,includeTags:false});if(!r.success)throw Error('友だちの検索に失敗しました');setHits(r.data.items);if(!r.data.items.length)setMessage('該当する友だちはいません。LINEの表示名を確認してください。')})}>友だちを検索</button></div>
    {!!hits.length&&<div className="max-h-60 overflow-auto rounded border bg-white p-3 space-y-2">{hits.map(f=><label key={f.id} className="block text-sm"><input type="checkbox" disabled={busy||!f.isFollowing||(!picked.some(p=>p.id===f.id)&&picked.length>=30)} checked={picked.some(p=>p.id===f.id)} onChange={e=>setPicked(list=>e.target.checked?[...list,f]:list.filter(p=>p.id!==f.id))} /> {f.displayName||'名前なし'} <small className="text-gray-500">({f.id.slice(0,8)}) {!f.isFollowing?'ブロック中':''}</small></label>)}</div>}
    {!!picked.length&&<p className="text-sm">選択中 {picked.length}人：{picked.map(f=>f.displayName||'名前なし').join('、')}</p>}
    <button type="button" className={button} disabled={busy||!data?.testActive||!group||!picked.length} onClick={()=>void run(async()=>{
      const r=await call<{results:Array<{friendId:string;success:boolean;error?:string}>}>('POST',{groupId:group,friendIds:picked.map(f=>f.id)})
      const failed=r.results.filter(x=>!x.success),successful=new Set(r.results.filter(x=>x.success).map(x=>x.friendId))
      setPicked(list=>list.filter(f=>!successful.has(f.id)));setMessage(`${successful.size}人にテスト用メニューを設定しました。`)
      if(failed.length)setError(failed.map(x=>`${picked.find(f=>f.id===x.friendId)?.displayName||'名前なし'}：${x.error}`).join('\n'))
      await load()
    })}>{busy?'処理中…':'選択したメンバーを追加'}</button>
    <div><h4 className="font-semibold text-sm">登録済み {data?.members.length??'—'}人</h4>{data?.members.length===0&&<p className="mt-2 text-sm text-gray-500">まだ登録されていません。</p>}<ul className="divide-y">{data?.members.map(m=><li key={m.friendId} className="flex flex-wrap items-center justify-between gap-2 py-3"><div className="text-sm"><strong>{m.displayName}</strong> <small>({m.friendId.slice(0,8)})</small><p className={m.state==='active'?'text-green-800':'text-amber-800'}>{m.state==='active'?'テスト用メニューを表示中':m.state==='changed'?'LINE側でメニューが変更されています':'LINE接続を確認できません。再読み込みしてください'}</p></div><button type="button" className={button} disabled={busy} onClick={()=>{if(!window.confirm(`${m.displayName} の登録を解除し、メニューを元に戻しますか？`))return;void run(async()=>{await call('DELETE',undefined,`/${encodeURIComponent(m.friendId)}`);await load();setMessage('登録を解除しました。')})}}>登録を解除</button></li>)}</ul></div>
    <p className="text-xs text-gray-600">解除時は追加前の個別メニューに戻します。以前のメニューがない場合は公式アカウントの標準メニューになります。全員の標準メニューや過去のFAQメッセージは変更しません。</p>
    {message&&<p role="status" className="whitespace-pre-wrap text-sm">{message}</p>}{error&&<p role="alert" className="whitespace-pre-wrap text-sm text-red-700">{error}</p>}
  </div>
}
