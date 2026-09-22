import { describe, it, expect, beforeAll } from 'vitest'
import { getInstances } from './servers.js'
import { loginAs, raw, ACCOUNTS } from './helpers.js'

describe('认证与稳定错误 JSON', () => {
  let instances
  beforeAll(async () => {
    instances = await getInstances()
  })

  it('错误口令返回 401 稳定 JSON', async () => {
    const err = await raw(instances.a, 'POST', '/api/auth/login', {
      body: { username: 'lead', password: 'wrong' }
    }).catch((e) => e)
    expect(err.status).toBe(401)
    expect(err.code).toBe('BAD_CREDENTIALS')
    expect(err.payload).toEqual({ error: { code: 'BAD_CREDENTIALS', message: '用户名或口令错误' } })
  })

  it('坏 JSON 返回 400 INVALID_JSON', async () => {
    const res = await fetch(`${instances.a.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json'
    })
    expect(res.status).toBe(400)
    const payload = await res.json()
    expect(payload.error.code).toBe('INVALID_JSON')
  })

  it('未带凭信访问受保护接口返回 401', async () => {
    const err = await raw(instances.a, 'GET', '/api/tickets').catch((e) => e)
    expect(err.status).toBe(401)
    expect(err.code).toBe('UNAUTHORIZED')
  })

  it('Bearer 令牌与 Cookie 两种凭信都有效', async () => {
    const login = await raw(instances.a, 'POST', '/api/auth/login', {
      body: { username: 'lead', password: 'lead-123' }
    })
    const viaBearer = await raw(instances.b, 'GET', '/api/auth/me', { token: login.token })
    expect(viaBearer.user.username).toBe('lead')

    const res = await fetch(`${instances.a.url}/api/auth/me`, {
      headers: { Cookie: `session=${login.token}` }
    })
    expect(res.status).toBe(200)
  })
})

describe('角色与授权边界（FORBIDDEN）', () => {
  let instances
  let coord
  let lead
  let worker1
  let worker2

  beforeAll(async () => {
    instances = await getInstances()
    coord = await loginAs(...ACCOUNTS.coordinator, instances.a)
    lead = await loginAs(...ACCOUNTS.lead, instances.a)
    worker1 = await loginAs(...ACCOUNTS.worker1, instances.a)
    worker2 = await loginAs(...ACCOUNTS.worker2, instances.b)
  })

  async function makeTicket(workerNames) {
    const { workers } = await coord('GET', '/api/workers')
    const ids = workers.filter((w) => workerNames.includes(w.username)).map((w) => w.id)
    const r = await coord('POST', '/api/tickets', {
      title: '权限边界票',
      points: ['点 A', '点 B'],
      workerIds: ids
    })
    return r.snapshot
  }

  it('送电负责人不能新建票；工作人员不能新建票', async () => {
    const e1 = await lead('POST', '/api/tickets', {
      title: 'x',
      points: ['a'],
      workerIds: []
    }).catch((e) => e)
    expect(e1.status).toBe(403)
    expect(e1.code).toBe('FORBIDDEN')

    const e2 = await worker1('POST', '/api/tickets', {
      title: 'x',
      points: ['a'],
      workerIds: []
    }).catch((e) => e)
    expect(e2.status).toBe(403)
  })

  it('工作人员不能复位；送电负责人不能确认隔离点', async () => {
    const ticket = await makeTicket(['worker1'])
    const e1 = await worker1('POST', `/api/tickets/${ticket.id}/reset`, {
      expectedRevision: ticket.revision
    }).catch((e) => e)
    expect(e1.status).toBe(403)

    const e2 = await lead(
      'POST',
      `/api/tickets/${ticket.id}/points/${ticket.points[0].id}/confirm`,
      { expectedRevision: ticket.revision }
    ).catch((e) => e)
    expect(e2.status).toBe(403)
  })

  it('未被该票授权的工作人员不能确认、挂锁、撤锁', async () => {
    const ticket = await makeTicket(['worker1']) // worker2 不在授权列表
    const e1 = await worker2(
      'POST',
      `/api/tickets/${ticket.id}/points/${ticket.points[0].id}/confirm`,
      { expectedRevision: ticket.revision }
    ).catch((e) => e)
    expect(e1.status).toBe(403)

    const e2 = await worker2('POST', `/api/tickets/${ticket.id}/locks`, {
      expectedRevision: ticket.revision
    }).catch((e) => e)
    expect(e2.status).toBe(403)

    const e3 = await worker2('DELETE', `/api/tickets/${ticket.id}/locks/mine`, {
      expectedRevision: ticket.revision
    }).catch((e) => e)
    expect(e3.status).toBe(403)
  })

  it('不存在的票返回 404', async () => {
    const e = await lead('GET', '/api/tickets/00000000-0000-0000-0000-000000000099').catch((x) => x)
    expect(e.status).toBe(404)
    expect(e.code).toBe('TICKET_NOT_FOUND')
  })
})

describe('建票校验与票全生命周期', () => {
  let instances
  let coord
  let worker1
  let lead

  beforeAll(async () => {
    instances = await getInstances()
    coord = await loginAs(...ACCOUNTS.coordinator, instances.a)
    worker1 = await loginAs(...ACCOUNTS.worker1, instances.b)
    lead = await loginAs(...ACCOUNTS.lead, instances.a)
  })

  it('隔离点必须为 1～20 个', async () => {
    const { workers } = await coord('GET', '/api/workers')
    const id = workers[0].id
    const tooFew = await coord('POST', '/api/tickets', {
      title: 't',
      points: [],
      workerIds: [id]
    }).catch((e) => e)
    expect(tooFew.status).toBe(422)

    const tooMany = await coord('POST', '/api/tickets', {
      title: 't',
      points: Array.from({ length: 21 }, (_, i) => `点${i}`),
      workerIds: [id]
    }).catch((e) => e)
    expect(tooMany.status).toBe(422)

    // 边界 20 允许
    const ok = await coord('POST', '/api/tickets', {
      title: '满 20 点',
      points: Array.from({ length: 20 }, (_, i) => `点${i + 1}`),
      workerIds: [id]
    })
    expect(ok.snapshot.points).toHaveLength(20)
  })

  it('至少一名授权人员且必须是工作人员', async () => {
    const e1 = await coord('POST', '/api/tickets', {
      title: 't',
      points: ['a']
    }).catch((e) => e)
    expect(e1.status).toBe(422)

    // 把送电负责人 id 当工作人员 → 拒绝
    const me = await lead('GET', '/api/auth/me')
    const e2 = await coord('POST', '/api/tickets', {
      title: 't',
      points: ['a'],
      workerIds: [me.user.id]
    }).catch((e) => e)
    expect(e2.status).toBe(422)
  })

  it('完整生命周期：确认 → 有锁阻断复位 → 撤锁 → 仍有点未确认 → 确认完 → 复位成功', async () => {
    const { workers } = await coord('GET', '/api/workers')
    const w1 = workers.find((w) => w.username === 'worker1').id
    const ticket = (
      await coord('POST', '/api/tickets', {
        title: '生命周期票',
        points: ['拉开关', '关阀门'],
        workerIds: [w1]
      })
    ).snapshot
    const id = ticket.id
    expect(ticket.revision).toBe(1)

    // 点未全确认 + 无锁：阻断
    let err = await lead('POST', `/api/tickets/${id}/reset`, {
      expectedRevision: ticket.revision
    }).catch((e) => e)
    expect(err.status).toBe(422)
    expect(err.code).toBe('RESET_BLOCKED')
    expect(err.details.blockers).toContain('POINTS_UNCONFIRMED')
    expect(err.details.unconfirmedPointPositions).toEqual([1, 2])

    // worker1 确认点 1
    let r = await worker1('POST', `/api/tickets/${id}/points/${ticket.points[0].id}/confirm`, {
      expectedRevision: ticket.revision
    })
    expect(r.snapshot.revision).toBe(2)
    let snap = r.snapshot

    // 重复确认同一时点：422
    err = await worker1(
      'POST',
      `/api/tickets/${id}/points/${ticket.points[0].id}/confirm`,
      { expectedRevision: snap.revision }
    ).catch((e) => e)
    expect(err.status).toBe(422)
    expect(err.details.alreadyConfirmed).toBe(true)

    // 挂锁（每人限一把）
    r = await worker1('POST', `/api/tickets/${id}/locks`, { expectedRevision: snap.revision })
    snap = r.snapshot
    expect(snap.viewer.holdsLock).toBe(true)

    err = await worker1('POST', `/api/tickets/${id}/locks`, {
      expectedRevision: snap.revision
    }).catch((e) => e)
    expect(err.status).toBe(422)
    expect(err.code).toBe('LOCK_ALREADY_HELD')

    // 有锁时复位被阻断，阻断项含锁
    err = await lead('POST', `/api/tickets/${id}/reset`, {
      expectedRevision: snap.revision
    }).catch((e) => e)
    expect(err.status).toBe(422)
    expect(err.details.blockers).toContain('LOCKS_PRESENT')
    expect(err.details.lockCount).toBe(1)

    // 撤锁（再撤报 NO_LOCK）
    r = await worker1('DELETE', `/api/tickets/${id}/locks/mine`, {
      expectedRevision: snap.revision
    })
    snap = r.snapshot
    expect(snap.lockCount).toBe(0)
    err = await worker1('DELETE', `/api/tickets/${id}/locks/mine`, {
      expectedRevision: snap.revision
    }).catch((e) => e)
    expect(err.status).toBe(409)
    expect(err.code).toBe('NO_LOCK')

    // 确认点 2
    r = await worker1('POST', `/api/tickets/${id}/points/${ticket.points[1].id}/confirm`, {
      expectedRevision: snap.revision
    })
    snap = r.snapshot
    expect(snap.resetBlocked).toBe(false)

    // 复位成功
    r = await lead('POST', `/api/tickets/${id}/reset`, { expectedRevision: snap.revision })
    snap = r.snapshot
    expect(snap.status).toBe('RESET')
    expect(snap.resetAt).toBeTruthy()

    // 终态：确认、挂锁全部拒绝（修订号正确 → TICKET_RESET）
    err = await worker1(
      'POST',
      `/api/tickets/${id}/points/${ticket.points[0].id}/confirm`,
      { expectedRevision: snap.revision }
    ).catch((e) => e)
    expect(err.status).toBe(409)
    expect(err.code).toBe('TICKET_RESET')

    err = await worker1('POST', `/api/tickets/${id}/locks`, {
      expectedRevision: snap.revision
    }).catch((e) => e)
    expect(err.status).toBe(409)
    expect(err.code).toBe('TICKET_RESET')
  })

  it('每次变更都必须携带页面所见修订号；缺失/错误类型返回 422', async () => {
    const { workers } = await coord('GET', '/api/workers')
    const w1 = workers.find((w) => w.username === 'worker1').id
    const ticket = (
      await coord('POST', '/api/tickets', {
        title: '修订号票',
        points: ['x'],
        workerIds: [w1]
      })
    ).snapshot

    const err = await worker1(
      'POST',
      `/api/tickets/${ticket.id}/points/${ticket.points[0].id}/confirm`,
      {}
    ).catch((e) => e)
    expect(err.status).toBe(422)
  })
})
