import React from 'react'

export interface FaqHandoffContext { classification: string; createdAt: string }

export function FaqHandoffContexts({ contexts }: { contexts?: FaqHandoffContext[] }) {
  if (!contexts?.length) return null
  return (
    <section className="space-y-1" aria-label="FAQの受付履歴">
      <h4 className="text-[11px] font-medium text-gray-500">FAQの受付履歴（最新20件）</h4>
      {contexts.map((context, index) => (
        <p key={`${context.createdAt}-${index}`} className="text-xs text-gray-700 break-words">
          <span className="text-gray-500">{context.createdAt.replace('T', ' ').slice(0, 16)}　</span>{context.classification}
        </p>
      ))}
    </section>
  )
}
