'use client'

import { useCallback, useEffect, useState } from 'react'
import { fetchApi } from '@/lib/api'
import { getApiBase } from '@/lib/api-base'

interface CaseItem {
  id: string; status: string; version: number; createdAt: string
  selection: { classification?: string }; contactIds: Record<string, string>
  attachments: Array<{ id: string; content_type: string; size_bytes: number }>
}
const labels: Record<string, string> = { draft: '入力待ち', awaiting_image: '画像待ち', submitted: '受付済み', checking: '確認中', needs_staff: '要対応', answered: '回答済み', closed: '終了' }
const transitions: Record<string, string[]> = { draft: ['closed'], awaiting_image: ['closed'], submitted: ['checking', 'closed'], checking: ['needs_staff', 'answered', 'closed'], needs_staff: ['answered', 'closed'], answered: ['closed'], closed: [] }
function tokyo(value: string) { return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) }

export function FaqCases({ friendId }: { friendId: string | null }) {
  const [items, setItems] = useState<CaseItem[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [image, setImage] = useState<{ url: string; id: string } | null>(null)
  const base = `/api/faq-cases/friends/${encodeURIComponent(friendId || '')}`
  const load = useCallback(async () => {
    if (!friendId) return
    const r = await fetchApi<{ success: boolean; data: CaseItem[] }>(`/api/faq-cases/friends/${encodeURIComponent(friendId)}`)
    if (!r.success) throw Error()
    setItems(r.data); setError('')
  }, [friendId])
  useEffect(() => {
    let active = true
    setItems([]); setError(''); setImage(null)
    if (friendId) void fetchApi<{ success: boolean; data: CaseItem[] }>(`/api/faq-cases/friends/${encodeURIComponent(friendId)}`).then(r => {
      if (active) { if (r.success) setItems(r.data); else setError('案件を取得できませんでした。') }
    }).catch(() => { if (active) setError('案件を取得できませんでした。') })
    return () => { active = false }
  }, [friendId])
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url) }, [image])
  async function change(item: CaseItem, status: string) {
    setBusy(true)
    try { await fetchApi(`${base}/${item.id}/status`, { method: 'POST', body: JSON.stringify({ status, expectedVersion: item.version }) }); await load() }
    catch { setError('更新できませんでした。再読込して状態を確認してください。') }
    finally { setBusy(false) }
  }
  async function openImage(item: CaseItem, attachmentId: string) {
    setBusy(true);setError('')
    try {
      const r = await fetch(`${getApiBase()}${base}/${item.id}/images/${attachmentId}`, { credentials: 'include', cache: 'no-store' })
      if (!r.ok) throw Error()
      setImage({ url: URL.createObjectURL(await r.blob()), id: attachmentId })
    } catch { setImage(null);setError('画像を取得できませんでした。取消済みの可能性があります。') }
    finally { setBusy(false) }
  }
  async function withdraw(item: CaseItem) {
    if (!window.confirm('添付画像を取り消しますか？画像へのアクセスを停止し、保存先から削除します。')) return
    setBusy(true); setImage(null)
    try { await fetchApi(`${base}/${item.id}/withdraw-image`, { method: 'POST', body: '{}' }); await load() }
    catch { setError('画像を取り消せませんでした。再読込して確認してください。') }
    finally { setBusy(false) }
  }
  return <section className="space-y-3" aria-label="FAQの問い合わせ案件">
    <div className="flex items-center justify-between"><h4 className="text-xs font-semibold">FAQの問い合わせ案件</h4><button type="button" disabled={busy} className="text-xs text-green-800" onClick={() => { setImage(null); void load().catch(() => setError('案件を取得できませんでした。')) }}>再読込</button></div>
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    {!items.length && !error && <p className="text-xs text-gray-500">案件はありません。</p>}
    {items.map(item => <article key={item.id} className="rounded-lg border border-gray-200 p-3 space-y-2 text-xs">
      <div className="flex justify-between"><span className="font-semibold">{labels[item.status] || item.status}</span><time>{tokyo(item.createdAt)}</time></div>
      <p className="break-words">{item.selection.classification}</p>
      <p className="text-[10px] text-gray-500 break-all">{item.id}</p>
      {Object.entries(item.contactIds).map(([kind, value]) => <p key={kind}>{kind === 'game_id' ? 'Game ID' : 'JOPT Games ID'}：<span className="font-mono">{value}</span></p>)}
      {item.attachments.map(a => <div key={a.id}><button type="button" disabled={busy} className="text-green-800 underline" onClick={() => void openImage(item, a.id)}>添付画像を確認（{Math.ceil(a.size_bytes / 1024)} KB）</button>{image?.id === a.id && <><img alt="FAQ添付画像" src={image.url} className="mt-2 max-w-full rounded" /><button type="button" onClick={() => setImage(null)}>閉じる</button></>}</div>)}
      {!!item.attachments.length && <button type="button" disabled={busy} className="text-red-700 underline" onClick={() => void withdraw(item)}>添付画像を取り消す</button>}
      <div className="flex flex-wrap gap-2">{(transitions[item.status] || []).map(status => <button key={status} type="button" disabled={busy} className="rounded border px-2 py-1 disabled:opacity-40" onClick={() => void change(item, status)}>{labels[status]}にする</button>)}</div>
    </article>)}
  </section>
}
