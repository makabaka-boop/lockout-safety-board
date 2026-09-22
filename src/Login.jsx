import React, { useMemo, useState } from 'react'

const ROLE_LABELS = {
  COORDINATOR: '协调员',
  WORKER: '检修人员',
  ENERGIZE_LEAD: '送电负责人'
}

export default function Login({ client, onLoggedIn }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const demoAccounts = useMemo(
    () => [
      ['coordinator / coord-123', '协调员'],
      ['worker1 / worker-123', '检修人员'],
      ['worker2 / worker-123', '检修人员'],
      ['worker3 / worker-123', '检修人员'],
      ['lead / lead-123', '送电负责人']
    ],
    []
  )

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { token, user } = await client.login(username.trim(), password)
      onLoggedIn(token, user)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login-form" onSubmit={submit}>
        <h1>检修隔离牌板</h1>
        <p className="muted">上锁挂牌（LOTO）作业控制台，请使用分配的账号登录。</p>
        <label>
          用户名
          <input
            data-testid="login-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label>
          口令
          <input
            data-testid="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && (
          <div className="error" data-testid="login-error">
            {error}
          </div>
        )}
        <button data-testid="login-submit" disabled={busy} className="primary">
          {busy ? '登录中…' : '登录'}
        </button>
        <div className="demo-accounts">
          <div className="muted small">演示账号（口令即第二列）：</div>
          <ul>
            {demoAccounts.map(([acc, role]) => (
              <li key={acc}>
                <code>{acc}</code> <span className="tag">{ROLE_LABELS[role]}</span>
              </li>
            ))}
          </ul>
        </div>
      </form>
    </div>
  )
}
