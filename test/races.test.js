import { describe, it, expect, beforeAll } from 'vitest'
import { getInstances } from './servers.js'
import { loginBoth, loginAs, raw, createTicket, confirmAllPoints, dbState, assertSnapshotMatchesDb, ACCOUNTS } from './helpers.js'

// 真实数据库 + 两个 API 实例上的并发裁决验收：
//  - “撤最后一锁”与“复位”交错不得产生失锁更新
//  - 复位最多成功一次
//  - 败方所见阻断项或终态必须与数据库一致
describe('跨实例并发裁决（真实 PostgreSQL）', () => {
  let instances
  let coord
  let workers
  let workerIds
  let idOf
  let worker1
  let worker2

  beforeAll(async () => {
    instances = await getInstances()
    // 协调员在实例 A 操作
    coord = await loginAs(...ACCOUNTS.coordinator, instances.a)
    workers = (await coord('GET', '/api/workers')).workers
    workerIds = workers.map((w) => w.id)
    // 按用户名取 id（接口按姓名排序，切片不等于 worker1/worker2）
    idOf = (username) => workers.find((w) => w.username === username).id
    const both1 = await loginBoth(...ACCOUNTS.worker1)
    const both2 = await loginBoth(...ACCOUNTS.worker2)
    worker1 = both1
    worker2 = both2
  })

  it('两张旧页面同时点“复位送电”：恰好一张成功，败方拿到最新终态快照', async () => {
    const ticket = await createTicket(coord, {
      title: '双复位竞争',
      pointCount: 2,
      workers: [idOf('worker1'), idOf('worker2')]
    })
    // worker1 确认两个点（跨两个实例交替）
    let snap = ticket
    for (const p of snap.points) {
      const r = await worker1.a('POST', `/api/tickets/${snap.id}/points/${p.id}/confirm`, {
        expectedRevision: snap.revision
      })
      snap = r.snapshot
    }
    expect(snap.resetBlocked).toBe(false)
    const resetRevision = snap.revision

    // 两个送电负责人会话（模拟两个浏览器）各持相同旧快照，分别打到两个实例
    const leadA = await loginAs(...ACCOUNTS.lead, instances.a)
    const leadB = await loginAs(...ACCOUNTS.lead, instances.b)

    const [r1, r2] = await Promise.allSettled([
      leadA('POST', `/api/tickets/${ticket.id}/reset`, { expectedRevision: resetRevision }),
      leadB('POST', `/api/tickets/${ticket.id}/reset`, { expectedRevision: resetRevision })
    ])

    const outcomes = [r1, r2].map((r) => (r.status === 'fulfilled' ? { ok: true, value: r.value } : { ok: false, reason: r.reason }))
    const successes = outcomes.filter((o) => o.ok)
    const failures = outcomes.filter((o) => !o.ok)

    expect(successes.length).toBe(1)
    expect(failures.length).toBe(1)

    // 败方：409 STALE_REVISION（不是“也成功”，也不是 422 阻断），并携带终态快照
    const loser = failures[0].reason
    expect(loser.status).toBe(409)
    expect(loser.code).toBe('STALE_REVISION')
    expect(loser.details.actualRevision).toBe(resetRevision + 1)
    expect(loser.details.snapshot.status).toBe('RESET')
    expect(loser.details.snapshot.active).toBe(false)

    const db = await dbState(ticket.id)
    expect(db.status).toBe('RESET')
    expect(db.revision).toBe(resetRevision + 1)
    assertSnapshotMatchesDb(successes[0].value.snapshot, db)
    assertSnapshotMatchesDb(loser.details.snapshot, db)
  })

  it('“撤最后一锁”与“复位”交错：复位绝不在锁存在时成功；败方看到的快照与数据库一致，重试后复位恰好成功一次', async () => {
    for (let round = 0; round < 12; round++) {
      const ticket = await createTicket(coord, {
        title: `撤锁/复位交错 #${round + 1}`,
        pointCount: 1,
        workers: [idOf('worker1')]
      })
      let snap = await confirmAllPoints(worker1.a, ticket)
      // 已确认完毕且挂着唯一一把锁：这是“撤最后一锁”与“复位”最危险的交错点
      snap = (await worker1.b('POST', `/api/tickets/${snap.id}/locks`, {
        expectedRevision: snap.revision
      })).snapshot
      expect(snap.lockCount).toBe(1)
      expect(snap.resetBlocked).toBe(true)
      expect(snap.resetState.blockers).toContain('LOCKS_PRESENT')
      const baseRevision = snap.revision

      const leadA = await loginAs(...ACCOUNTS.lead, instances.a)
      const leadB = await loginAs(...ACCOUNTS.lead, instances.b)

      // 撤锁（实例 A）与复位（实例 B）依据同一页面修订号同发
      const [removeResult, resetResult] = await Promise.allSettled([
        worker1.a('DELETE', `/api/tickets/${snap.id}/locks/mine`, {
          expectedRevision: baseRevision
        }),
        leadB('POST', `/api/tickets/${snap.id}/reset`, { expectedRevision: baseRevision })
      ])

      const remove = removeResult.status === 'fulfilled'
        ? { ok: true, value: removeResult.value }
        : { ok: false, reason: removeResult.reason }
      const reset = resetResult.status === 'fulfilled'
        ? { ok: true, value: resetResult.value }
        : { ok: false, reason: resetResult.reason }
      const db = await dbState(ticket.id)

      // 不变量 1：存在个人锁时复位绝不许成功 —— 不允许“失锁更新”导致误送电
      if (reset.ok) {
        expect(remove.ok).toBe(false)
        expect(db.locks.length).toBe(1)
      } else {
        // 撤锁必然成功：若复位先占锁，复位因阻断回滚，撤锁随后提交；
        //   若撤锁先提交，复位依据旧修订号/回滚后快照推进，收到 409
        expect(remove.ok).toBe(true)
        expect(db.locks.length).toBe(0)
        expect(reset.reason.status).toBe(409)
        expect(reset.reason.code).toBe('STALE_REVISION')
        // 败方响应快照 == 数据库权威状态
        assertSnapshotMatchesDb(reset.reason.details.snapshot, db)
      }

      // 不变量 2：败方看到的快照与数据库逐项一致
      if (!remove.ok) assertSnapshotMatchesDb(remove.reason.details.snapshot, db)
      if (!reset.ok) assertSnapshotMatchesDb(reset.reason.details.snapshot, db)

      // 此刻票必然仍处于 ACTIVE（复位从未在有锁时发生）
      expect(db.status).toBe('ACTIVE')

      // 败方/刷新后的负责人按所见最新快照重试复位：成功，且是唯一一次成功
      const freshRevision = reset.ok
        ? reset.value.snapshot.revision // 理论上不会进入（有锁），保留兜底
        : reset.reason.details.snapshot.revision
      const retry = await leadA('POST', `/api/tickets/${ticket.id}/reset`, {
        expectedRevision: freshRevision
      })
      expect(retry.snapshot.status).toBe('RESET')
      const db2 = await dbState(ticket.id)
      expect(db2.status).toBe('RESET')
      assertSnapshotMatchesDb(retry.snapshot, db2)

      // 任何实例上的二次复位都失败（409 过期 或 422 终态阻断），且状态仍是同一个 RESET
      const retry2 = await leadB('POST', `/api/tickets/${ticket.id}/reset`, {
        expectedRevision: freshRevision
      }).catch((e) => e)
      expect([409, 422]).toContain(retry2.status)
      const db3 = await dbState(ticket.id)
      expect(db3.status).toBe('RESET')
      expect(db3.revision).toBe(db2.revision)
      assertSnapshotMatchesDb(retry2.details.snapshot, db3)
    }
  })

  it('两个实例交叉制造确认/挂锁变更：旧页面的每次写入都被 409 拒绝并得到最新快照，牌板修订号严格单调', async () => {
    const ticket = await createTicket(coord, {
      title: '跨实例修订号裁决',
      pointCount: 2,
      workers: [idOf('worker1'), idOf('worker2')]
    })
    let revision = ticket.revision
    const [p1, p2] = ticket.points

    // worker1 在 A 确认点 1
    let r = await worker1.a('POST', `/api/tickets/${ticket.id}/points/${p1.id}/confirm`, {
      expectedRevision: revision
    })
    expect(r.snapshot.revision).toBe(revision + 1)
    revision = r.snapshot.revision

    // worker2 在 B 用旧修订号确认点 2 → 409，返回最新快照
    const stale = await worker2.b('POST', `/api/tickets/${ticket.id}/points/${p2.id}/confirm`, {
      expectedRevision: ticket.revision
    }).catch((e) => e)
    expect(stale.status).toBe(409)
    expect(stale.code).toBe('STALE_REVISION')
    expect(stale.details.actualRevision).toBe(revision)
    const db = await dbState(ticket.id)
    assertSnapshotMatchesDb(stale.details.snapshot, db)

    // worker2 按最新快照重试 → 成功，修订号再 +1
    r = await worker2.b('POST', `/api/tickets/${ticket.id}/points/${p2.id}/confirm`, {
      expectedRevision: revision
    })
    expect(r.snapshot.revision).toBe(revision + 1)
    revision = r.snapshot.revision

    // 同修订号下两个实例并发挂锁（两个不同工人）：恰好一个成功
    const [hang1, hang2] = await Promise.allSettled([
      worker1.a('POST', `/api/tickets/${ticket.id}/locks`, { expectedRevision: revision }),
      worker2.b('POST', `/api/tickets/${ticket.id}/locks`, { expectedRevision: revision })
    ])
    const wins = [hang1, hang2].filter((x) => x.status === 'fulfilled')
    const loses = [hang1, hang2].filter((x) => x.status === 'rejected')
    expect(wins.length).toBe(1)
    expect(loses.length).toBe(1)
    expect(loses[0].reason.status).toBe(409)
    const db2 = await dbState(ticket.id)
    expect(db2.locks.length).toBe(1)
    assertSnapshotMatchesDb(wins[0].value.snapshot, db2)
    assertSnapshotMatchesDb(loses[0].reason.details.snapshot, db2)
  })

  it('复位成功后，任何迟到的确认或挂锁（即使带复位前修订号）一律被拒，且看到终态', async () => {
    const ticket = await createTicket(coord, {
      title: '复位后迟到请求',
      pointCount: 1,
      workers: [idOf('worker1'), idOf('worker2')]
    })
    // worker1 确认点并曾挂锁；撤锁后由负责人复位
    let snap = await confirmAllPoints(worker1.a, ticket)
    snap = (await worker1.b('POST', `/api/tickets/${snap.id}/locks`, { expectedRevision: snap.revision })).snapshot
    const oldRevisionWithLock = snap.revision
    snap = (await worker1.a('DELETE', `/api/tickets/${snap.id}/locks/mine`, { expectedRevision: snap.revision })).snapshot
    const lead = await loginAs(...ACCOUNTS.lead, instances.a)
    snap = (await lead('POST', `/api/tickets/${snap.id}/reset`, { expectedRevision: snap.revision })).snapshot
    expect(snap.status).toBe('RESET')

    const db = await dbState(ticket.id)

    // worker2 持极旧页面（挂锁时的修订号）尝试确认 —— 先撞 409，看到终态
    const staleConfirm = await raw(instances.b, 'POST', `/api/tickets/${ticket.id}/points/${ticket.points[0].id}/confirm`, {
      token: await getToken(instances.b, ...ACCOUNTS.worker2),
      body: { expectedRevision: oldRevisionWithLock }
    }).catch((e) => e)
    expect(staleConfirm.status).toBe(409)
    expect(staleConfirm.code).toBe('STALE_REVISION')
    expect(staleConfirm.details.snapshot.status).toBe('RESET')

    // 工人刷新后拿到终态修订号再尝试挂锁：409 TICKET_RESET（修订号正确，状态拒绝）
    const fresh = (await worker2.a('GET', `/api/tickets/${ticket.id}`)).snapshot
    const afterResetHang = await worker2.b('POST', `/api/tickets/${ticket.id}/locks`, {
      expectedRevision: fresh.revision
    }).catch((e) => e)
    expect(afterResetHang.status).toBe(409)
    expect(afterResetHang.code).toBe('TICKET_RESET')
    assertSnapshotMatchesDb(afterResetHang.details.snapshot, db)

    // 同样，负责人不能对终态二次复位（422，阻断项含 TICKET_NOT_ACTIVE）
    const secondReset = await lead('POST', `/api/tickets/${ticket.id}/reset`, {
      expectedRevision: fresh.revision
    }).catch((e) => e)
    expect(secondReset.status).toBe(422)
    expect(secondReset.code).toBe('RESET_BLOCKED')
    expect(secondReset.details.blockers).toContain('TICKET_NOT_ACTIVE')

    const dbAfter = await dbState(ticket.id)
    expect(dbAfter.status).toBe('RESET')
    expect(dbAfter.locks.length).toBe(0)
    expect(dbAfter.revision).toBe(db.revision)
  })
})

async function getToken(instance, username, password) {
  const r = await raw(instance, 'POST', '/api/auth/login', { body: { username, password } })
  return r.token
}
