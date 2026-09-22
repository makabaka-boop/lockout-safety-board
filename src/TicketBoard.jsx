import React, { useEffect, useState } from 'react'
import { ApiError } from './api'

const BLOCKER_TEXT = {
  TICKET_NOT_ACTIVE: '作业票已不在检修状态',
  POINTS_UNCONFIRMED: '仍有必检隔离点未确认',
  LOCKS_PRESENT: '仍有个人锁未撤下'
}

// 把后端错误渲染成稳定提示；409 额外展示“页面已自动重载到最新牌板”
function describeError(err) {
  if (!err) return null
  if (err instanceof ApiError && err.status === 409) {
    return err.code === 'TICKET_RESET'
      ? '该作业票已复位送电，页面已刷新为终态'
      : '页面所依据的牌板已过期，已自动按最新牌板重载，请重新操作'
  }
  if (err instanceof ApiError && err.code === 'RESET_BLOCKED') {
    const blockers = err.details?.blockers || []
    return '不能送电：' + blockers.map((b) => BLOCKER_TEXT[b] || b).join('；')
  }
  return err.message
}

export default function TicketBoard({ client, ticketId, viewer, onBack }) {
  const [snapshot, setSnapshot] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)

  async function reload(showNotice = false) {
    const { snapshot: fresh } = await client.getTicket(ticketId)
    setSnapshot(fresh)
    if (showNotice) setNotice('已按数据库最新牌板重载')
    return fresh
  }

  useEffect(() => {
    let alive = true
    reload()
      .catch((err) => alive && setError(err))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
    // ticketId 变化时整体重取（模拟进入/切换页面）
  }, [ticketId])

  // 执行变更；所有请求都携带页面当前所见修订号。
  // 409：后端在 details.snapshot 给了最新快照，直接采纳（界面“重载”）。
  async function mutate(action, label) {
    setError(null)
    setNotice(null)
    setBusy(label)
    try {
      const result = await action(snapshot.revision)
      setSnapshot(result.snapshot)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.details?.snapshot) {
        setSnapshot(err.details.snapshot)
      }
      setError(err)
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <div className="muted">载入牌板…</div>
  if (error && !snapshot) return <div className="error">牌板载入失败：{error.message}</div>
  if (!snapshot) return null

  const isWorker = viewer.role === 'WORKER'
  const isLead = viewer.role === 'ENERGIZE_LEAD'
  const authorized = snapshot.authorizedWorkers.some((w) => w.userId === viewer.id)
  const holdsLock = snapshot.viewer?.holdsLock

  return (
    <div className="ticket-board" data-testid="ticket-board" data-revision={snapshot.revision}>
      <button className="link" onClick={onBack} data-testid="back">
        ← 返回列表
      </button>

      <div className="card">
        <div className="board-head">
          <h2>{snapshot.title}</h2>
          <span className={`status-badge ${snapshot.active ? 'active' : 'reset'}`}>
            {snapshot.active ? '检修中' : '已复位送电'}
          </span>
        </div>
        <div className="muted small" data-testid="revision-line">
          修订号：{snapshot.revision} · 创建于 {new Date(snapshot.createdAt).toLocaleString('zh-CN')}
          {snapshot.resetAt ? ` · 复位于 ${new Date(snapshot.resetAt).toLocaleString('zh-CN')}` : ''}
        </div>

        {notice && (
          <div className="notice" data-testid="board-notice">
            {notice}
          </div>
        )}
        {error && (
          <div className="error" data-testid="board-error" data-error-code={error.code}>
            {describeError(error)}
            {error.code === 'RESET_BLOCKED' && (
              <div className="blocker-detail small muted">
                未确认点：
                {error.details?.unconfirmedPointPositions?.length
                  ? error.details.unconfirmedPointPositions.join('、')
                  : '无'}
                ；当前锁数：{error.details?.lockCount ?? 0}
              </div>
            )}
          </div>
        )}

        <section>
          <h3>必检隔离点（{snapshot.points.filter((p) => p.confirmed).length}/{snapshot.points.length}）</h3>
          <ul className="point-list">
            {snapshot.points.map((p) => (
              <li key={p.id} className={p.confirmed ? 'confirmed' : ''}>
                <div>
                  <span className="point-pos">#{p.position}</span> {p.label}
                </div>
                <div className="point-side">
                  {p.confirmed ? (
                    <span className="tag ok" data-testid={`point-state-${p.position}`}>
                      已确认（{p.confirmedByName}）
                    </span>
                  ) : (
                    <span className="tag warn" data-testid={`point-state-${p.position}`}>
                      待确认
                    </span>
                  )}
                  {isWorker &&
                    authorized &&
                    snapshot.active &&
                    !p.confirmed && (
                      <button
                        data-testid={`confirm-${p.position}`}
                        disabled={busy !== null}
                        onClick={() =>
                          mutate(
                            (rev) => client.confirmPoint(ticketId, p.id, rev),
                            `confirm-${p.position}`
                          )
                        }
                      >
                        确认
                      </button>
                    )}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3>个人锁（{snapshot.lockCount} 把）</h3>
          {snapshot.lockCount === 0 ? (
            <p className="muted small">当前无人挂锁。</p>
          ) : (
            <ul className="lock-list">
              {snapshot.locks.map((l) => (
                <li key={l.id} data-testid={`lock-${l.userId}`}>
                  🔒 {l.userName}（{new Date(l.lockedAt).toLocaleTimeString('zh-CN')}）
                </li>
              ))}
            </ul>
          )}
          {isWorker && authorized && snapshot.active && (
            <div className="row-actions">
              {holdsLock ? (
                <button
                  data-testid="remove-lock"
                  disabled={busy !== null}
                  onClick={() => mutate((rev) => client.removeLock(ticketId, rev), 'remove-lock')}
                >
                  撤下我的锁
                </button>
              ) : (
                <button
                  className="warn"
                  data-testid="add-lock"
                  disabled={busy !== null}
                  onClick={() => mutate((rev) => client.addLock(ticketId, rev), 'add-lock')}
                >
                  挂上我的个人锁
                </button>
              )}
            </div>
          )}
          {isWorker && !authorized && (
            <p className="muted small">你不是该作业票的授权人员，不能确认隔离点或挂锁。</p>
          )}
        </section>

        {isLead && (
          <section>
            <h3>送电复位</h3>
            {snapshot.active ? (
              <>
                <button
                  className="danger"
                  data-testid="reset-button"
                  disabled={busy !== null}
                  onClick={() => mutate((rev) => client.reset(ticketId, rev), 'reset')}
                >
                  复位并送电
                </button>
                {snapshot.resetBlocked && (
                  <p className="muted small" data-testid="reset-hint">
                    当前阻断项：
                    {snapshot.resetState.blockers
                      .map((b) => BLOCKER_TEXT[b] || b)
                      .join('；')}
                  </p>
                )}
              </>
            ) : (
              <p className="tag ok" data-testid="reset-done">
                已复位送电（终态，拒绝一切确认与挂锁）
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
