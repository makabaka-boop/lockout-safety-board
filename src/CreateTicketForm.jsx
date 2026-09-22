import React, { useEffect, useState } from 'react'

// 协调员新建作业票：1~20 个隔离点 + 至少一名授权人员
export default function CreateTicketForm({ client, onCreated, onCancel }) {
  const [title, setTitle] = useState('')
  const [pointText, setPointText] = useState('')
  const [workers, setWorkers] = useState([])
  const [selected, setSelected] = useState(() => new Set())
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    client
      .listWorkers()
      .then((r) => setWorkers(r.workers))
      .catch((err) => setError(err.message))
  }, [client])

  const points = pointText
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function submit(e) {
    e.preventDefault()
    setError(null)
    if (points.length < 1 || points.length > 20) {
      setError(`隔离点必须为 1 至 20 个，当前 ${points.length} 个`)
      return
    }
    if (selected.size < 1) {
      setError('至少勾选一名授权检修人员')
      return
    }
    setBusy(true)
    try {
      const { snapshot } = await client.createTicket({
        title: title.trim(),
        points,
        workerIds: [...selected]
      })
      onCreated(snapshot)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" data-testid="create-ticket" onSubmit={submit}>
      <h2>新建作业票</h2>
      <label>
        作业票标题
        <input
          data-testid="ticket-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：1 号泵电机检修"
          maxLength={200}
        />
      </label>
      <label>
        必检隔离点（每行一个，1～20 个）
        <textarea
          data-testid="ticket-points"
          rows={5}
          value={pointText}
          onChange={(e) => setPointText(e.target.value)}
          placeholder={'拉开 1 号泵进线开关\n关闭进水阀并上锁挂牌'}
        />
      </label>
      <div className="muted small" data-testid="point-count">
        当前隔离点数：{points.length}
      </div>
      <fieldset>
        <legend>授权检修人员（可确认隔离点、挂个人锁）</legend>
        <div className="worker-checks">
          {workers.map((w) => (
            <label key={w.id} className="check">
              <input
                type="checkbox"
                data-testid={`assign-${w.username}`}
                checked={selected.has(w.id)}
                onChange={() => toggle(w.id)}
              />
              {w.displayName}（{w.username}）
            </label>
          ))}
        </div>
      </fieldset>
      {error && (
        <div className="error" data-testid="create-error">
          {error}
        </div>
      )}
      <div className="row-actions">
        <button type="submit" className="primary" disabled={busy} data-testid="ticket-submit">
          {busy ? '提交中…' : '创建作业票'}
        </button>
        <button type="button" onClick={onCancel} data-testid="ticket-cancel">
          取消
        </button>
      </div>
    </form>
  )
}
