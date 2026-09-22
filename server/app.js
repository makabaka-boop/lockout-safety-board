import { randomUUID, randomBytes } from 'node:crypto'
import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyCors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { query, withTransaction, buildSnapshot, lockTicket, bumpRevision, createTicket, computeResetBlockers } from './repo.js'
import { hashPassword, verifyPassword } from './password.js'
import {
  HttpError,
  invalidJson,
  invalidInput,
  unauthorized,
  forbidden,
  notFound,
  staleRevision,
  ticketResetError,
  noLock,
  lockAlreadyHeld,
  resetBlocked
} from './errors.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// 业务失败后统一在新事务读取数据库权威快照附给调用方（原事务已回滚）：
//   - 若牌板已被他人推进（修订号变化/已终态），把阻断类错误升级为 409 STALE_REVISION；
//   - 否则保留原始错误（如确实有锁、有点未确认）。
// 这样“败方所见”永远是其收到响应那一刻的数据库最新牌板。
async function finalizeError(error, ticketId, viewerId, expectedRevision) {
  if (error instanceof HttpError && [409, 422].includes(error.status) && ticketId) {
    try {
      // FOR UPDATE 等待并发写者提交，杜绝“回滚瞬间读到旧牌板”
      const snapshot = await withTransaction((client) =>
        buildSnapshot(client, ticketId, viewerId, { forUpdate: true })
      )
      if (snapshot && !error.noSnapshotRewrite && error.code !== 'STALE_REVISION' && snapshot.revision !== expectedRevision) {
        const upgraded = staleRevision(expectedRevision, snapshot.revision)
        upgraded.details = { ...(upgraded.details || {}), snapshot }
        throw upgraded
      }
      if (snapshot) {
        // 保留错误原有 details（如 blockers），仅补充最新快照
        error.details = { ...(error.details || {}), snapshot }
      }    } catch (rewrap) {
      if (rewrap instanceof HttpError && rewrap.code === 'STALE_REVISION') throw rewrap
      // 快照读取失败时保留原错误
    }
  }
  throw error
}

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'warn' },
    bodyLimit: 1024 * 1024
  })

  await app.register(fastifyCookie)
  // 开发态 Vite 跨端口取数；测试也从不同端口发请求。
  await app.register(fastifyCors, {
    origin: true,
    credentials: true
  })

  // JSON 解析失败 → 稳定 JSON，而不是 Fastify 默认的 HTML
  app.setErrorHandler((error, request, reply) => {
    if (error.statusCode === 400 && /JSON/.test(error.message)) {
      const e = invalidJson()
      return reply.status(e.status).send({ error: { code: e.code, message: e.message } })
    }
    if (error instanceof HttpError) {
      const body = { error: { code: error.code, message: error.message } }
      if (error.details !== undefined) body.error.details = error.details
      return reply.status(error.status).send(body)
    }
    request.log.error(error)
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } })
  })

  // ---- 认证 ----

  // 支持两种凭信：浏览器用会话 Cookie；测试/非浏览器客户端用 Bearer。
  async function getUserFromRequest(request) {
    const auth = request.headers.authorization
    let token
    if (auth && auth.startsWith('Bearer ')) token = auth.slice(7)
    else token = request.cookies?.session

    if (!token) return null
    const result = await query(
      `SELECT u.id, u.username, u.display_name, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = $1`,
      [token]
    )
    return result.rows[0] || null
  }

  async function requireAuth(request) {
    const user = await getUserFromRequest(request)
    if (!user) throw unauthorized()
    return user
  }

  function requireRole(user, roles) {
    if (!roles.includes(user.role)) {
      throw forbidden('当前账号角色无权执行此操作')
    }
  }

  // 授权人员：票的授权列表（授权在创建后不变，锁外读取也安全）
  async function getAssignment(ticketId, userId) {
    const result = await query(
      'SELECT 1 FROM ticket_assignments WHERE ticket_id = $1 AND user_id = $2',
      [ticketId, userId]
    )
    return result.rowCount > 0
  }

  function setSessionCookie(reply, token) {
    reply.setCookie('session', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
      maxAge: 12 * 60 * 60
    })
  }

  // 成功变更的统一响应
  function snapshotReply(reply, snapshot) {
    return reply.send({ revision: snapshot.revision, snapshot })
  }

  app.post('/api/auth/login', async (request, reply) => {
    const { username, password } = request.body || {}
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw invalidInput('需要 username 与 password')
    }
    const result = await query(
      `SELECT u.id, u.username, u.display_name, u.role, s.salt, s.hash
         FROM users u JOIN auth_secrets s ON s.user_id = u.id
        WHERE u.username = $1`,
      [username]
    )
    const row = result.rows[0]
    if (!row || !verifyPassword(password, `${row.salt}:${row.hash}`)) {
      // 统一文案，避免泄露账号是否存在
      throw new HttpError(401, 'BAD_CREDENTIALS', '用户名或口令错误')
    }
    const token = randomBytes(32).toString('hex')
    await query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, row.id])
    setSessionCookie(reply, token)
    return reply.send({
      token,
      user: { id: row.id, username: row.username, displayName: row.display_name, role: row.role }
    })
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const auth = request.headers.authorization
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : request.cookies?.session
    if (token) await query('DELETE FROM sessions WHERE token = $1', [token])
    reply.clearCookie('session', { path: '/' })
    return reply.status(204).send()
  })

  app.get('/api/auth/me', async (request, reply) => {
    const user = await getUserFromRequest(request)
    if (!user) throw unauthorized()
    return reply.send({
      user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role }
    })
  })

  // 协调员可选人员：全部工作人员（WORKER）
  app.get('/api/workers', async (request, reply) => {
    await requireAuth(request)
    const { rows } = await query(
      "SELECT id, username, display_name FROM users WHERE role = 'WORKER' ORDER BY display_name"
    )
    return reply.send({ workers: rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name })) })
  })

  // ---- 作业票 ----

  app.get('/api/tickets', async (request, reply) => {
    const user = await requireAuth(request)
    const { rows } = await query(
      `SELECT t.id, t.title, t.status, t.revision, t.created_at, t.reset_at,
              u.display_name AS created_by_name,
              (SELECT count(*) FROM ticket_points p WHERE p.ticket_id = t.id) AS point_count,
              (SELECT count(*) FROM ticket_points p WHERE p.ticket_id = t.id AND p.confirmed_by IS NOT NULL) AS confirmed_count,
              (SELECT count(*) FROM personal_locks l WHERE l.ticket_id = t.id) AS lock_count
         FROM tickets t JOIN users u ON u.id = t.created_by
        ORDER BY t.created_at DESC`,
      []
    )
    return reply.send({
      tickets: rows.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        active: r.status === 'ACTIVE',
        revision: Number(r.revision),
        createdAt: new Date(r.created_at).toISOString(),
        resetAt: r.reset_at ? new Date(r.reset_at).toISOString() : null,
        createdByName: r.created_by_name,
        pointCount: Number(r.point_count),
        confirmedCount: Number(r.confirmed_count),
        lockCount: Number(r.lock_count)
      }))
    })
  })

  app.get('/api/tickets/:id', async (request, reply) => {
    const user = await requireAuth(request)
    if (!UUID_RE.test(request.params.id)) throw notFound()
    const snapshot = await withTransaction((client) => buildSnapshot(client, request.params.id, user.id))
    if (!snapshot) throw notFound()
    return reply.send({ snapshot })
  })

  // 协调员新建票
  app.post('/api/tickets', async (request, reply) => {
    const user = await requireAuth(request)
    requireRole(user, ['COORDINATOR'])

    const { title, points, workerIds } = request.body || {}
    if (typeof title !== 'string' || !title.trim()) {
      throw invalidInput('title 必填')
    }
    if (!Array.isArray(points) || points.length < 1 || points.length > 20) {
      throw invalidInput('隔离点数量必须为 1 至 20 个')
    }
    if (!points.every((p) => typeof p === 'string' && p.trim() && p.length <= 100)) {
      throw invalidInput('每个隔离点名称为不超过 100 字的非空字符串')
    }
    if (!Array.isArray(workerIds) || workerIds.length < 1) {
      throw invalidInput('至少指定一名授权工作人员')
    }
    if (workerIds.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
      throw invalidInput('workerIds 必须为合法用户 id')
    }

    const uniqueWorkers = [...new Set(workerIds)]
    const { rowCount } = await query(
      "SELECT id FROM users WHERE role = 'WORKER' AND id = ANY($1::uuid[])",
      [uniqueWorkers]
    )
    if (rowCount !== uniqueWorkers.length) {
      throw invalidInput('存在不存在或非工作人员的授权对象')
    }

    const ticketId = await withTransaction((client) =>
      createTicket(
        client,
        { title: title.trim(), points: points.map((p) => p.trim()), workerIds: uniqueWorkers },
        user.id
      )
    )
    const snapshot = await withTransaction((client) => buildSnapshot(client, ticketId, user.id))
    return reply.status(201).send({ revision: snapshot.revision, snapshot })
  })

  // 工作人员确认必检点
  app.post('/api/tickets/:id/points/:pointId/confirm', async (request, reply) => {
    const user = await requireAuth(request)
    requireRole(user, ['WORKER'])
    const { id: ticketId, pointId } = request.params
    if (!UUID_RE.test(ticketId) || !UUID_RE.test(pointId)) throw notFound()
    const expectedRevision = (request.body || {}).expectedRevision

    // 角色+授权检查先于票锁与修订号：越权返回 FORBIDDEN，不泄露牌板状态
    if (!(await getAssignment(ticketId, user.id))) throw forbidden()

    try {
      const snapshot = await withTransaction(async (client) => {
        const ticket = await lockTicket(client, ticketId, expectedRevision)
        if (!ticket) throw notFound()
        if (ticket.status !== 'ACTIVE') throw ticketResetError()

        const pointResult = await client.query(
          'SELECT * FROM ticket_points WHERE id = $1 AND ticket_id = $2 FOR UPDATE',
          [pointId, ticketId]
        )
        if (pointResult.rowCount === 0) throw invalidInput('隔离点不存在或不属于该作业票')
        const point = pointResult.rows[0]
        if (point.confirmed_by) {
          throw invalidInput('该隔离点已确认', { alreadyConfirmed: true, pointPosition: point.position })
        }

        await client.query(
          'UPDATE ticket_points SET confirmed_by = $1, confirmed_at = now() WHERE id = $2',
          [user.id, pointId]
        )
        await bumpRevision(client, ticketId)
        return buildSnapshot(client, ticketId, user.id)
      })
      return snapshotReply(reply, snapshot)
    } catch (err) {
      await finalizeError(err, ticketId, user.id, expectedRevision)
      throw err
    }
  })

  // 挂自己唯一的一把个人锁
  app.post('/api/tickets/:id/locks', async (request, reply) => {
    const user = await requireAuth(request)
    requireRole(user, ['WORKER'])
    const ticketId = request.params.id
    if (!UUID_RE.test(ticketId)) throw notFound()
    const expectedRevision = (request.body || {}).expectedRevision
    if (!(await getAssignment(ticketId, user.id))) throw forbidden()

    try {
      const snapshot = await withTransaction(async (client) => {
        const ticket = await lockTicket(client, ticketId, expectedRevision)
        if (!ticket) throw notFound()
        if (ticket.status !== 'ACTIVE') throw ticketResetError()

        const existing = await client.query(
          'SELECT id FROM personal_locks WHERE ticket_id = $1 AND user_id = $2',
          [ticketId, user.id]
        )
        if (existing.rowCount > 0) throw lockAlreadyHeld()

        await client.query('INSERT INTO personal_locks (id, ticket_id, user_id) VALUES ($1, $2, $3)', [
          randomUUID(),
          ticketId,
          user.id
        ])
        await bumpRevision(client, ticketId)
        return buildSnapshot(client, ticketId, user.id)
      })
      return snapshotReply(reply, snapshot)
    } catch (err) {
      await finalizeError(err, ticketId, user.id, expectedRevision)
      throw err
    }
  })

  // 撤下自己唯一的个人锁
  app.delete('/api/tickets/:id/locks/mine', async (request, reply) => {
    const user = await requireAuth(request)
    requireRole(user, ['WORKER'])
    const ticketId = request.params.id
    if (!UUID_RE.test(ticketId)) throw notFound()
    const expectedRevision = (request.body || {}).expectedRevision
    if (!(await getAssignment(ticketId, user.id))) throw forbidden()

    try {
      const snapshot = await withTransaction(async (client) => {
        const ticket = await lockTicket(client, ticketId, expectedRevision)
        if (!ticket) throw notFound()
        if (ticket.status !== 'ACTIVE') throw ticketResetError()

        const result = await client.query(
          'DELETE FROM personal_locks WHERE ticket_id = $1 AND user_id = $2 RETURNING id',
          [ticketId, user.id]
        )
        if (result.rowCount === 0) throw noLock()

        await bumpRevision(client, ticketId)
        return buildSnapshot(client, ticketId, user.id)
      })
      return snapshotReply(reply, snapshot)
    } catch (err) {
      await finalizeError(err, ticketId, user.id, expectedRevision)
      throw err
    }
  })

  // 送电负责人复位：全部点已确认 + 锁数为零 + 票仍在检修；
  // 快照、裁决、复位、修订号推进必须原子提交。
  app.post('/api/tickets/:id/reset', async (request, reply) => {
    const user = await requireAuth(request)
    requireRole(user, ['ENERGIZE_LEAD'])
    const ticketId = request.params.id
    if (!UUID_RE.test(ticketId)) throw notFound()
    const expectedRevision = (request.body || {}).expectedRevision

    try {
      const snapshot = await withTransaction(async (client) => {
        const ticket = await lockTicket(client, ticketId, expectedRevision)
        if (!ticket) throw notFound()

        // 锁内重新读取复位依据，杜绝“撤最后一锁”与“复位”交错
        const pointsResult = await client.query(
          'SELECT * FROM ticket_points WHERE ticket_id = $1 ORDER BY position FOR SHARE',
          [ticketId]
        )
        const locksResult = await client.query(
          'SELECT id FROM personal_locks WHERE ticket_id = $1 FOR SHARE',
          [ticketId]
        )
        const state = computeResetBlockers(ticket, pointsResult.rows, locksResult.rows.length)
        if (state.blockers.length > 0) {
          throw resetBlocked(state)
        }

        await client.query(
          "UPDATE tickets SET status = 'RESET', reset_at = now(), revision = revision + 1 WHERE id = $1",
          [ticketId]
        )
        return buildSnapshot(client, ticketId, user.id)
      })
      return snapshotReply(reply, snapshot)
    } catch (err) {
      await finalizeError(err, ticketId, user.id, expectedRevision)
      throw err
    }
  })

  // ---- 生产态静态页面（compose 里由 nginx 托管，直连 API 端口也可用）----
  const distDir = path.join(__dirname, '..', 'dist')
  if (fs.existsSync(distDir)) {
    await app.register(fastifyStatic, { root: distDir, wildcard: false })
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith('/api/')) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } })
      }
      return reply.sendFile('index.html')
    })
  }

  return app
}
