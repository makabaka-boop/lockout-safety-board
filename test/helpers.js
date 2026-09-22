import { expect } from 'vitest'
import { getInstances } from './servers.js'

// 以指定账号在指定实例上登录，返回绑定该实例的请求函数
export async function loginAs(username, password, instance) {
  const res = await raw(instance, 'POST', '/api/auth/login', {
    body: { username, password }
  })
  const token = res.token
  return (method, p, body) => raw(instance, method, p, { token, body })
}

export async function loginBoth(username, password) {
  const { a, b } = await getInstances()
  const [asA, asB] = await Promise.all([
    loginAs(username, password, a),
    loginAs(username, password, b)
  ])
  return { a: asA, b: asB }
}

// 预置账号（与 server/seed.js 一致）
export const ACCOUNTS = {
  coordinator: ['coordinator', 'coord-123'],
  worker1: ['worker1', 'worker-123'],
  worker2: ['worker2', 'worker-123'],
  worker3: ['worker3', 'worker-123'],
  lead: ['lead', 'lead-123']
}

export async function raw(instance, method, path, { token, body } = {}) {
  const res = await fetch(`${instance.url}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { raw: text }
    }
  }
  if (!res.ok) {
    const err = new Error(payload?.error?.message || res.statusText)
    err.status = res.status
    err.code = payload?.error?.code
    err.details = payload?.error?.details
    err.payload = payload
    throw err
  }
  return payload
}

// 用协调员在指定实例新建一张票；points 个数可配，授权 worker 可传 id 或 {id} 对象
export async function createTicket(asCoordinator, { title = '竞争测试票', pointCount = 2, workers } = {}) {
  const workerIds = workers.map((u) => (typeof u === 'string' ? u : u.id))
  const r = await asCoordinator('POST', '/api/tickets', {
    title,
    points: Array.from({ length: pointCount }, (_, i) => `隔离点 ${i + 1}`),
    workerIds
  })
  return r.snapshot
}

// 全量确认一张票（工作人员本人调用），返回最终快照
export async function confirmAllPoints(actor, ticket) {
  let snap = ticket
  const pending = snap.points.filter((p) => !p.confirmed)
  for (const p of pending) {
    const r = await actor('POST', `/api/tickets/${snap.id}/points/${p.id}/confirm`, {
      expectedRevision: snap.revision
    })
    snap = r.snapshot
  }
  return snap
}

// 从数据库直接读取权威状态，用于“败方所见与数据库一致”断言
export async function dbState(ticketId) {
  const { getPool } = await import('../server/repo.js')
  const pool = getPool()
  const [ticket, points, locks] = await Promise.all([
    pool.query('SELECT status, revision, reset_at FROM tickets WHERE id = $1', [ticketId]),
    pool.query(
      'SELECT position, confirmed_by IS NOT NULL AS confirmed FROM ticket_points WHERE ticket_id = $1 ORDER BY position',
      [ticketId]
    ),
    pool.query('SELECT user_id FROM personal_locks WHERE ticket_id = $1 ORDER BY user_id', [ticketId])
  ])
  return {
    status: ticket.rows[0].status,
    revision: Number(ticket.rows[0].revision),
    resetAt: ticket.rows[0].reset_at ? new Date(ticket.rows[0].reset_at).toISOString() : null,
    confirmedAll: points.rows.every((p) => p.confirmed),
    unconfirmed: points.rows.filter((p) => !p.confirmed).map((p) => p.position),
    locks: locks.rows.map((r) => r.user_id)
  }
}

// 比对响应快照与数据库权威状态
export function assertSnapshotMatchesDb(snap, db) {
  expect(snap.status).toBe(db.status)
  expect(snap.revision).toBe(db.revision)
  expect(snap.lockCount).toBe(db.locks.length)
  expect(snap.points.every((p) => p.confirmed)).toBe(db.confirmedAll)
  expect([...snap.locks.map((l) => l.userId)].sort()).toEqual([...db.locks].sort())
}
