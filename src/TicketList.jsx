import React from 'react'

const STATUS_TEXT = { ACTIVE: '检修中', RESET: '已复位送电' }

export default function TicketList({ tickets, onOpen }) {
  return (
    <div className="ticket-list">
      <h2>作业票列表</h2>
      {tickets.length === 0 && <p className="muted">还没有作业票。</p>}
      {tickets.map((t) => (
        <button
          key={t.id}
          className="card ticket-row"
          data-testid={`ticket-row-${t.id}`}
          onClick={() => onOpen(t.id)}
        >
          <div className="ticket-row-main">
            <span className={`status-badge ${t.status === 'ACTIVE' ? 'active' : 'reset'}`}>
              {STATUS_TEXT[t.status]}
            </span>
            <strong>{t.title}</strong>
            <span className="muted small">创建人：{t.createdByName}</span>
          </div>
          <div className="ticket-row-meta small muted">
            隔离点 {t.confirmedCount}/{t.pointCount} 已确认 · 个人锁 {t.lockCount} 把 · 修订号 {t.revision}
          </div>
        </button>
      ))}
    </div>
  )
}
