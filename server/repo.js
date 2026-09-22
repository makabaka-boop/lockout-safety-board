import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { connectionString } from './db.js'
import { staleRevision, invalidInput } from './errors.js'

const { Pool } = pg

let pool
export function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString, max: 10 })
  }
  return pool
}

export async function query(text, params) {
  return getPool().query(text, params)
}

// 在事务内执行回调；回调内抛出任何错误都会整体回滚。
// 并发裁决全部发生在此事务内：先锁票行，再核对修订号。
export async function withTransaction(fn) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

const iso = (ts) => (ts ? new Date(ts).toISOString() : null)

// 送电复位阻断项：全部必检点已确认、个人锁为零、票仍处于检修中。
// 必须在持有票行锁后调用，保证与即将执行的 UPDATE 同属一个裁决。
export function computeResetBlockers(ticket, points, lockCount) {
  const blockers = []
  if (ticket.status !== 'ACTIVE') blockers.push('TICKET_NOT_ACTIVE')
  const unconfirmed = points.filter((p) => !p.confirmed_by).map((p) => p.position)
  if (unconfirmed.length) blockers.push('POINTS_UNCONFIRMED')
  if (lockCount > 0) blockers.push('LOCKS_PRESENT')
  return { blockers, unconfirmedPointPositions: unconfirmed, lockCount }
}

// 构建对外稳定快照（每次变更、每次冲突、每次刷新所见结构一致）。
// forUpdate=true 时票行读取加 FOR UPDATE：失败收尾用它等待并发写者提交，
// 保证败方拿到的快照一定是其事务被驳回之后数据库的权威状态。
export async function buildSnapshot(client, ticketId, viewerId, { forUpdate = false } = {}) {
  const ticketResult = await client.query(
    `SELECT * FROM tickets WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [ticketId]
  )
  if (ticketResult.rowCount === 0) return null
  const ticket = ticketResult.rows[0]

  const pointsResult = await client.query(
    'SELECT id, position, label, confirmed_by, confirmed_at FROM ticket_points WHERE ticket_id = $1 ORDER BY position',
    [ticketId]
  )
  const locksResult = await client.query(
    `SELECT l.id, l.user_id, u.display_name AS user_name, l.locked_at
       FROM personal_locks l JOIN users u ON u.id = l.user_id
      WHERE l.ticket_id = $1 ORDER BY l.locked_at, l.user_id`,
    [ticketId]
  )
  const assignmentResult = await client.query(
    `SELECT a.user_id, u.username, u.display_name
       FROM ticket_assignments a JOIN users u ON u.id = a.user_id
      WHERE a.ticket_id = $1 ORDER BY u.display_name`,
    [ticketId]
  )
  const viewerLockResult = viewerId
    ? await client.query('SELECT id FROM personal_locks WHERE ticket_id = $1 AND user_id = $2', [
        ticketId,
        viewerId
      ])
    : { rows: [] }

  const points = pointsResult.rows.map((p) => ({
    id: p.id,
    position: p.position,
    label: p.label,
    confirmed: p.confirmed_by != null,
    confirmedBy: p.confirmed_by,
    confirmedByName: null,
    confirmedAt: iso(p.confirmed_at)
  }))

  // 补确认人姓名（一张票最多 20 个点，直接在用户列表里查即可）
  const users = new Map(
    locksResult.rows.map((l) => [l.user_id, l.user_name])
  )
  const pointIds = new Set(points.map((p) => p.confirmedBy).filter(Boolean))
  let nameRows = []
  if (pointIds.size) {
    const { rows } = await client.query('SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])', [
          [...pointIds]
    ])
    nameRows = rows
  }
  const names = new Map(nameRows.map((r) => [r.id, r.display_name]))
  for (const p of points) {
    if (p.confirmedBy) p.confirmedByName = names.get(p.confirmedBy) || null
  }

  const locks = locksResult.rows.map((l) => ({
    id: l.id,
    userId: l.user_id,
    userName: l.user_name,
    lockedAt: iso(l.locked_at)
  }))

  const authorizedWorkers = assignmentResult.rows.map((a) => ({
    userId: a.user_id,
    username: a.username,
    displayName: a.display_name
  }))

  const resetState = computeResetBlockers(ticket, pointsResult.rows, locks.length)

  return {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    active: ticket.status === 'ACTIVE',
    revision: Number(ticket.revision),
    createdBy: ticket.created_by,
    createdAt: iso(ticket.created_at),
    resetAt: iso(ticket.reset_at),
    points,
    locks,
    lockCount: locks.length,
    authorizedWorkers,
    viewer: viewerId
      ? {
          id: viewerId,
          holdsLock: viewerLockResult.rows.length === 1
        }
      : null,
    resetBlocked: resetState.blockers.length > 0,
    resetState: {
      blockers: resetState.blockers,
      unconfirmedPointPositions: resetState.unconfirmedPointPositions,
      lockCount: resetState.lockCount
    }
  }
}

// 在票行锁内核对期望修订号；不匹配即抛 STALE_REVISION（事务随后回滚，
// 调用方负责附带最新快照）。返回锁定读取到的票行。
export async function lockTicket(client, ticketId, expectedRevision) {
  const result = await client.query('SELECT * FROM tickets WHERE id = $1 FOR UPDATE', [ticketId])
  if (result.rowCount === 0) return null
  const ticket = result.rows[0]
  // 请求必须显式携带页面所见修订号；缺失/非法是调用方输入错误（422），
  // 不能被失败收尾逻辑二次包装成过期冲突。
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    const err = invalidInput('expectedRevision 必须为页面所见的正整数修订号')
    err.noSnapshotRewrite = true
    throw err
  }
  if (Number(ticket.revision) !== expectedRevision) {
    throw staleRevision(expectedRevision, Number(ticket.revision))
  }
  return ticket
}

// 修订号 +1（所有变更的唯一出口，保证单调）
export async function bumpRevision(client, ticketId) {
  const result = await client.query(
    'UPDATE tickets SET revision = revision + 1 WHERE id = $1 RETURNING revision',
    [ticketId]
  )
  return Number(result.rows[0].revision)
}

// 协调员新建作业票：1~20 个隔离点、指定授权人员，票与明细原子创建。
export async function createTicket(client, { title, points, workerIds }, coordinatorId) {
  const ticketId = randomUUID()
  await client.query(
    'INSERT INTO tickets (id, title, status, revision, created_by) VALUES ($1, $2, $3, 1, $4)',
    [ticketId, title, 'ACTIVE', coordinatorId]
  )

  for (let i = 0; i < points.length; i++) {
    await client.query(
      'INSERT INTO ticket_points (id, ticket_id, position, label) VALUES ($1, $2, $3, $4)',
      [randomUUID(), ticketId, i + 1, points[i]]
    )
  }

  for (const userId of workerIds) {
    await client.query(
      'INSERT INTO ticket_assignments (ticket_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [ticketId, userId]
    )
  }

  return ticketId
}
