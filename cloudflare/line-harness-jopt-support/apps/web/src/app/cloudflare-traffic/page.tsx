'use client'

import { useEffect, useState } from 'react'
import Header from '@/components/layout/header'
import { fetchApi } from '@/lib/api'

type CapacityMetric = {id:string;label:string;used:number|null;limit:number|null;remaining:number|null;percent:number|null;unit:'count'|'bytes';severity:'normal'|'warning'|'critical'|'exhausted'|'unknown';resetAt:string|null}
type CapacitySection = {status:'ready'|'not_configured'|'unavailable'|'permission_error'|'paused';scope:string;fetchedAt:string;from?:string;to?:string;metrics:CapacityMetric[];credentialExpiry?:string}
type Capacity = {cloudflare:CapacitySection;appwrite:CapacitySection}
const amount = (n:number|null,unit:string) => n===null?'未取得':unit==='bytes'?n>=1e9?`${number(n/1e9)} GB`:n>=1e6?`${number(n/1e6)} MB`:`${number(n/1e3)} KB`:number(n)
const capacityNotice={not_configured:'用量APIに未接続です。',permission_error:'用量APIの読み取り権限を確認してください。',unavailable:'公式用量を取得できません。残量は未確認です。',paused:'プロジェクトが停止中です。公式コンソールで状態を確認してください。'}
function CapacityCards({data}:{data:Capacity}) {
  return <section className="space-y-5">
    {(['appwrite','cloudflare'] as const).map(key=>{const section=data[key];return <section key={key} className="rounded-xl border bg-white p-5 space-y-4">
      <div><h2 className="text-lg font-semibold">{key==='appwrite'?'画像・ファイル：Appwrite':'アプリ・チャット：Cloudflare'}</h2><p className="text-xs text-gray-500">{section.scope} · 取得 {date(section.fetchedAt)} JST</p></div>
      <p className="text-xs text-gray-500">統計接続キー：{section.credentialExpiry==='never'?'有効期限なし':section.credentialExpiry&&section.credentialExpiry!=='unknown'?`${section.credentialExpiry.slice(0,10)} まで`:'期限未確認'}{section.credentialExpiry&&section.credentialExpiry!=='never'&&section.credentialExpiry!=='unknown'&&Date.parse(section.credentialExpiry)-Date.now()<30*86400000?' · 更新が必要です':''}</p>
      {section.status!=='ready'?<p role="status" className="rounded-lg bg-amber-50 p-4">{capacityNotice[section.status]}</p>:<>
        <div className="grid gap-4 md:grid-cols-2">{section.metrics.map(m=><div key={m.id} className={`rounded-xl border p-4 ${m.severity==='exhausted'||m.severity==='critical'?'border-red-300 bg-red-50':m.severity==='warning'?'border-amber-300 bg-amber-50':'bg-gray-50'}`}>
          <div className="flex justify-between gap-2"><h3 className="text-sm text-gray-600">{m.label}</h3><span className="text-xs">{{normal:'余裕あり',warning:'75%以上使用',critical:'90%以上使用',exhausted:'上限到達',unknown:'残量未確認'}[m.severity]}</span></div>
          <p className="mt-3 text-2xl font-semibold">残り {amount(m.remaining,m.unit)}</p><p className="mt-1 text-sm text-gray-600">使用 {amount(m.used,m.unit)} ／ 上限 {amount(m.limit,m.unit)}{m.percent!==null?` (${number(m.percent)}%)`:''}</p>
          {m.percent!==null&&<progress aria-label={`${m.label} 使用率`} className="mt-3 h-2 w-full" value={Math.min(m.percent,100)} max={100}/>}
          <p className="mt-2 text-xs text-gray-500">{m.resetAt?(m.id==='appwriteBandwidth'?`次期開始日 ${m.resetAt.slice(0,10)}（公式画面の日付。時刻未確認）`:`次回リセット ${date(m.resetAt)} JST`):m.id==='appwriteBandwidth'?'結算周期が未確認のため残量は算出しません。':'保存容量は期間が変わってもリセットされません。'}</p>
        </div>)}</div>
        {key==='cloudflare'&&<p className="text-xs text-gray-500">Free枠：毎日09:00 JSTにリセット。D1容量は当日の公式集計で観測された最大値です。</p>}
        {key==='appwrite'&&<p className="text-xs text-gray-500">公式APIのプロジェクト用量と公式画面のFree枠から参考残量を算出します（GBは10億バイト換算）。組織内に別プロジェクトを追加した場合やプラン変更時は再確認が必要です。</p>}
      </>}
    </section>})}
    <p className="text-sm text-gray-600">残量と稼働状態は別です。Appwrite Freeは開発活動がない場合に自動停止することがあります。未取得の項目はゼロとして扱いません。</p>
  </section>
}

type Point = { time: string; requests: number; errors: number; subrequests: number }
type Ready = { status: 'ready'; worker: string; from: string; to: string; fetchedAt: string; series: Point[];
  totals: { requests: number; errors: number; subrequests: number; errorRate: number; cpuP50Ms: number|null; cpuP99Ms: number|null } }
type Data = Ready | { status: 'not_configured'|'permission_error'|'unavailable' }
const number = (n: number) => n.toLocaleString('ja-JP', { maximumFractionDigits: 2 })
const date = (s: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(s))
const notice = { not_configured: 'Cloudflareの統計に未接続です。管理者側で接続設定が必要です。', permission_error: 'Cloudflareの統計を読み取れません。管理者に接続権限の確認を依頼してください。', unavailable: 'Cloudflareの統計を取得できませんでした。しばらくしてから更新してください。' }

export default function CloudflareTrafficPage() {
  const [period, setPeriod] = useState('24h'), [reload, setReload] = useState(0)
  const [capacity,setCapacity]=useState<Capacity|null>(null),[capacityError,setCapacityError]=useState('')
  const [data, setData] = useState<Data|null>(null), [busy, setBusy] = useState(true), [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setBusy(true); setError(''); setData(null)
    void fetchApi<{success:boolean;data:Data}>(`/api/cloudflare-traffic?period=${period}`, {signal:controller.signal}).then(r => {
      if (!controller.signal.aborted) { if (!r.success) throw new Error(); setData(r.data) }
    }).catch(() => { if (!controller.signal.aborted) setError('統計を表示できません。管理者権限と接続状態を確認してください。') }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [period, reload])
  useEffect(()=>{
    const controller=new AbortController();setCapacityError('');
    void fetchApi<{success:boolean;data:Capacity}>('/api/service-capacity',{signal:controller.signal}).then(r=>{if(!controller.signal.aborted){if(!r.success)throw new Error();setCapacity(r.data)}}).catch(()=>{if(!controller.signal.aborted){setCapacity(null);setCapacityError('公式用量を取得できませんでした。残量は未確認です。')}});
    return()=>controller.abort()
  },[reload])
  const metrics = data?.status === 'ready' ? data : null
  const max = Math.max(1, ...(metrics?.series.map(p => p.requests) || []))
  return <>
    <Header title="サービス残量・稼働状況" description="無料枠の使用量・残量・リセット時刻" />
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-center justify-between gap-3"><p className="text-sm text-gray-600">公式APIの使用量と確認済みのプラン上限 · 日本時間（JST）</p><button onClick={()=>setReload(x=>x+1)} className="rounded-lg border px-4 py-2">残量を更新</button></div>
      {capacityError&&<p role="alert" className="rounded-lg bg-amber-50 p-4">{capacityError}</p>}
      {capacity?<CapacityCards data={capacity}/>:!capacityError&&<p role="status">公式用量を読み込み中…</p>}
      <details className="rounded-xl border bg-white p-5 space-y-5"><summary className="cursor-pointer font-semibold">参考：Harness Workerのアクセス・CPU統計</summary>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-600">Cloudflare公式統計 · 日本時間（JST）</p>
        <div className="flex gap-3"><select aria-label="集計期間" value={period} onChange={e=>setPeriod(e.target.value)} className="rounded-lg border p-2"><option value="24h">過去24時間</option><option value="7d">過去7日間</option></select>
          <button disabled={busy} onClick={()=>setReload(x=>x+1)} className="rounded-lg border px-4 py-2 disabled:opacity-40">更新</button></div>
      </div>
      {busy && <p role="status">読み込み中…</p>}
      {error && <p role="alert" className="rounded-xl bg-red-50 p-5 text-red-800">{error}</p>}
      {data && data.status !== 'ready' && <p role="status" className="rounded-xl border bg-amber-50 p-5">{notice[data.status]}</p>}
      {metrics && <>
        <div className="text-sm text-gray-600"><p>対象：{metrics.worker}</p><p>{date(metrics.from)} ～ {date(metrics.to)} JST · 取得 {date(metrics.fetchedAt)}</p></div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ['リクエスト数', number(metrics.totals.requests)], ['実行エラー数', number(metrics.totals.errors)], ['エラー率', `${number(metrics.totals.errorRate)}%`],
            ['子リクエスト数', number(metrics.totals.subrequests)], ['CPU時間 P50', metrics.totals.cpuP50Ms == null ? '—' : `${number(metrics.totals.cpuP50Ms)} ms`], ['CPU時間 P99', metrics.totals.cpuP99Ms == null ? '—' : `${number(metrics.totals.cpuP99Ms)} ms`],
          ].map(([label,value])=><div key={label} className="rounded-xl border bg-white p-5"><p className="text-sm text-gray-500">{label}</p><p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p></div>)}
        </div>
        <section className="rounded-xl border bg-white p-5">
          <h2 className="font-semibold">時間別リクエスト</h2>
          {metrics.series.length ? <>
            <div role="img" aria-label="時間別リクエスト数。各時間の数値は下の表で確認できます。" className="mt-5 flex h-48 items-end gap-px border-b">
              {metrics.series.map(p=><div key={p.time} title={`${date(p.time)} JST：${number(p.requests)}件`} className="min-w-0 flex-1 bg-blue-500" style={{height:`${p.requests/max*100}%`}} />)}
            </div>
            <div className="mt-2 flex justify-between text-xs text-gray-500"><span>{date(metrics.series[0].time)}</span><span>{date(metrics.series.at(-1)!.time)} JST</span></div>
            <details className="mt-5"><summary className="cursor-pointer text-sm">時間別の数値を表示</summary><div className="mt-3 max-h-96 overflow-auto"><table className="w-full text-right text-sm"><caption className="sr-only">時間別のリクエスト・実行エラー・子リクエスト数</caption><thead><tr><th className="p-2 text-left">日本時間</th><th>リクエスト</th><th>エラー</th><th>子リクエスト</th></tr></thead><tbody>{metrics.series.map(p=><tr key={p.time} className="border-t"><td className="p-2 text-left">{date(p.time)}</td><td>{number(p.requests)}</td><td>{number(p.errors)}</td><td>{number(p.subrequests)}</td></tr>)}</tbody></table></div></details>
          </> : <p className="py-8 text-gray-500">この期間のリクエストはありません。</p>}
        </section>
        <p className="text-xs leading-6 text-gray-500">Workerへのアクセスには管理画面・Webhook・定期処理などが含まれます。子リクエストはWorkerから外部サービスなどへの呼び出しです。実行エラーはHTTPエラー件数とは異なります。Cloudflareの統計には集計遅延・サンプリングがあり、取得結果は最大60秒再利用します。</p>
      </>}
      </details>
    </main>
  </>
}
