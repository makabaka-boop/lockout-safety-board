// 前端 API 客户端。所有变更请求必须携带页面所见的 expectedRevision；
// 409 时抛出携带最新快照的冲突错误，由界面“按最新牌板重载”。

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

const TOKEN_KEY = 'loto.token'

export function loadToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function saveToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export async function apiRequest(method, path, { token, body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })

  if (res.status === 204) return null

  let payload = null
  const text = await res.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!res.ok) {
    const err = payload?.error || {}
    throw new ApiError(res.status, err.code || 'UNKNOWN', err.message || '请求失败', err.details)
  }
  return payload
}

export class ApiClient {
  constructor(token, onAuthLost) {
    this.token = token
    this.onAuthLost = onAuthLost
  }

  async request(method, path, body) {
    try {
      return await apiRequest(method, path, { token: this.token, body })
    } catch (err) {
      if (err.status === 401) this.onAuthLost?.()
      throw err
    }
  }

  me() {
    return this.request('GET', '/api/auth/me')
  }

  login(username, password) {
    return apiRequest('POST', '/api/auth/login', { body: { username, password } })
  }

  logout() {
    return this.request('POST', '/api/auth/logout')
  }

  listWorkers() {
    return this.request('GET', '/api/workers')
  }

  listTickets() {
    return this.request('GET', '/api/tickets')
  }

  getTicket(id) {
    return this.request('GET', `/api/tickets/${id}`)
  }

  createTicket(payload) {
    return this.request('POST', '/api/tickets', payload)
  }

  confirmPoint(ticketId, pointId, expectedRevision) {
    return this.request('POST', `/api/tickets/${ticketId}/points/${pointId}/confirm`, {
      expectedRevision
    })
  }

  addLock(ticketId, expectedRevision) {
    return this.request('POST', `/api/tickets/${ticketId}/locks`, { expectedRevision })
  }

  removeLock(ticketId, expectedRevision) {
    return this.request('DELETE', `/api/tickets/${ticketId}/locks/mine`, { expectedRevision })
  }

  reset(ticketId, expectedRevision) {
    return this.request('POST', `/api/tickets/${ticketId}/reset`, { expectedRevision })
  }
}
