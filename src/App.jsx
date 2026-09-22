import React, { useCallback, useEffect, useState } from 'react'
import { ApiClient, loadToken, saveToken } from './api'
import Login from './Login.jsx'
import TicketList from './TicketList.jsx'
import TicketBoard from './TicketBoard.jsx'
import CreateTicketForm from './CreateTicketForm.jsx'

const ROLE_LABELS = {
  COORDINATOR: '协调员',
  WORKER: '检修人员',
  ENERGIZE_LEAD: '送电负责人'
}

export default function App() {
  const [token, setToken] = useState(() => loadToken())
  const [user, setUser] = useState(null)
  const [authChecking, setAuthChecking] = useState(true)
  const [tickets, setTickets] = useState([])
  const [openTicketId, setOpenTicketId] = useState(null)
  const [creating, setCreating] = useState(false)

  const handleAuthLost = useCallback(() => {
    saveToken(null)
    setToken(null)
    setUser(null)
  }, [])

  const client = React.useMemo(
    () => new ApiClient(token || null, handleAuthLost),
    [token, handleAuthLost]
  )

  // 用本地保存的令牌恢复登录；覆盖“浏览器刷新/重载页面”场景
  useEffect(() => {
    if (!token) {
      setAuthChecking(false)
      return
    }
    client
      .me()
      .then((r) => setUser(r.user))
      .catch(() => handleAuthLost())
      .finally(() => setAuthChecking(false))
  }, [client, token, handleAuthLost])

  async function refreshList() {
    const r = await client.listTickets()
    setTickets(r.tickets)
  }

  useEffect(() => {
    if (user && !openTicketId) {
      refreshList().catch(() => {})
    }
  }, [user, openTicketId, creating])

  function handleLoggedIn(newToken, newUser) {
    saveToken(newToken)
    setToken(newToken)
    setUser(newUser)
  }

  async function logout() {
    try {
      await client.logout()
    } catch {
      // 忽略：本地仍要清除
    }
    saveToken(null)
    setToken(null)
    setUser(null)
    setOpenTicketId(null)
  }

  if (authChecking) return <div className="muted center">校验登录状态…</div>
  if (!user) return <Login client={client} onLoggedIn={handleLoggedIn} />

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => { setOpenTicketId(null); setCreating(false) }}>
          检修隔离牌板
        </button>
        <div className="who">
          <span data-testid="current-user">
            {user.displayName}（{user.username}）
          </span>
          <span className="tag">{ROLE_LABELS[user.role]}</span>
          <button onClick={logout} data-testid="logout">
            退出
          </button>
        </div>
      </header>

      <main className="content">
        {openTicketId ? (
          <TicketBoard
            client={client}
            ticketId={openTicketId}
            viewer={user}
            onBack={() => setOpenTicketId(null)}
          />
        ) : creating ? (
          <CreateTicketForm
            client={client}
            onCancel={() => setCreating(false)}
            onCreated={(snapshot) => {
              setCreating(false)
              setOpenTicketId(snapshot.id)
            }}
          />
        ) : (
          <>
            {user.role === 'COORDINATOR' && (
              <div className="row-actions">
                <button className="primary" data-testid="new-ticket" onClick={() => setCreating(true)}>
                  新建作业票
                </button>
                <button data-testid="refresh-list" onClick={() => refreshList()}>
                  刷新列表
                </button>
              </div>
            )}
            <TicketList tickets={tickets} onOpen={setOpenTicketId} />
          </>
        )}
      </main>
    </div>
  )
}
