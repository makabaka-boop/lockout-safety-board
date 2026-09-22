import { describe, it, expect, beforeAll, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { getInstances } from './servers.js'
import { loginAs, raw, ACCOUNTS } from './helpers.js'
import App from '../src/App.jsx'

let instances

// 让前端相对路径的 fetch 走真实 API 实例；两个实例等价，界面测试固定打 A
beforeAll(async () => {
  instances = await getInstances()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    // 前端相对路径补到实例 A；helpers 已带完整地址的请求原样透传
    const url = typeof input === 'string' ? input : input.url
    const finalUrl = url.startsWith('http') ? url : `${instances.a.url}${url}`
    return originalFetch(finalUrl, typeof input === 'string' ? init : input)
  }
})

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  document.body.innerHTML = ''
})

function renderApp() {
  return render(<App />)
}

async function login(username, password) {
  fireEvent.change(screen.getByTestId('login-username'), { target: { value: username } })
  fireEvent.change(screen.getByTestId('login-password'), { target: { value: password } })
  fireEvent.click(screen.getByTestId('login-submit'))
  await waitFor(() => expect(screen.getByTestId('current-user')).toBeInTheDocument())
}

async function createTicketUi(title, { pointLines, workers }) {
  fireEvent.click(screen.getByTestId('new-ticket'))
  await waitFor(() => expect(screen.getByTestId('create-ticket')).toBeInTheDocument())
  fireEvent.change(screen.getByTestId('ticket-title'), { target: { value: title } })
  fireEvent.change(screen.getByTestId('ticket-points'), {
    target: { value: pointLines.join('\n') }
  })
  // 授权人员列表异步加载，等复选框出现后再勾选
  for (const w of workers) {
    const box = await screen.findByTestId(`assign-${w}`)
    fireEvent.click(box)
  }
  fireEvent.click(screen.getByTestId('ticket-submit'))
  await waitFor(() => expect(screen.getByTestId('ticket-board')).toBeInTheDocument())
}

describe('界面：登录、建票、牌板操作', () => {
  it('协调员可建票；工作人员在界面上确认隔离点并挂/撤个人锁；送电负责人看到阻断并在条件满足后复位', async () => {
    renderApp()
    await login('coordinator', 'coord-123')
    await createTicketUi('界面端到端票', {
      pointLines: ['拉开主开关', '关闭进料阀'],
      workers: ['worker1', 'worker2']
    })

    // 牌板展示初始修订号 1、两个待确认点
    const board = screen.getByTestId('ticket-board')
    expect(board).toHaveAttribute('data-revision', '1')
    expect(screen.getByTestId('point-state-1').textContent).toContain('待确认')

    // 协调员界面不出现操作按钮
    expect(screen.queryByTestId('confirm-1')).not.toBeInTheDocument()

    // 换工作人员登录
    fireEvent.click(screen.getByTestId('logout'))
    await waitFor(() => expect(screen.getByTestId('login-username')).toBeInTheDocument())
    await login('worker1', 'worker-123')

    // 从列表进入该票
    const rows = await waitFor(() => {
      const buttons = document.querySelectorAll('[data-testid^="ticket-row-"]')
      expect(buttons.length).toBeGreaterThan(0)
      return buttons
    })
    // 找到标题匹配的那一行
    const row = [...rows].find((r) => r.textContent.includes('界面端到端票'))
    fireEvent.click(row)
    await waitFor(() => expect(screen.getByTestId('ticket-board')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('confirm-1'))
    await waitFor(() => expect(screen.getByTestId('point-state-1').textContent).toContain('已确认'))
    expect(screen.getByTestId('revision-line').textContent).toContain('修订号：2')

    // 挂锁 -> 出现撤锁按钮
    fireEvent.click(screen.getByTestId('add-lock'))
    await waitFor(() => expect(screen.getByTestId('remove-lock')).toBeInTheDocument())
    expect(screen.getByTestId('revision-line').textContent).toContain('修订号：3')

    // 撤锁
    fireEvent.click(screen.getByTestId('remove-lock'))
    await waitFor(() => expect(screen.getByTestId('add-lock')).toBeInTheDocument())

    // 确认点 2
    fireEvent.click(screen.getByTestId('confirm-2'))
    await waitFor(() => expect(screen.getByTestId('point-state-2').textContent).toContain('已确认'))

    // 换送电负责人：此时条件满足，复位成功并进入终态
    fireEvent.click(screen.getByTestId('logout'))
    await waitFor(() => expect(screen.getByTestId('login-username')).toBeInTheDocument())
    await login('lead', 'lead-123')
    const leadRows = document.querySelectorAll('[data-testid^="ticket-row-"]')
    fireEvent.click([...leadRows].find((r) => r.textContent.includes('界面端到端票')))
    await waitFor(() => expect(screen.getByTestId('reset-button')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('reset-button'))
    await waitFor(() => expect(screen.getByTestId('reset-done')).toBeInTheDocument())
  })

  it('未授权工作人员看不到操作按钮', async () => {
    renderApp()
    await login('coordinator', 'coord-123')
    await createTicketUi('仅授权1票', { pointLines: ['点一'], workers: ['worker1'] })
    fireEvent.click(screen.getByTestId('logout'))
    await waitFor(() => expect(screen.getByTestId('login-username')).toBeInTheDocument())
    await login('worker2', 'worker-123')
    const row = await waitFor(() => {
      const r = [...document.querySelectorAll('[data-testid^="ticket-row-"]')].find((x) =>
        x.textContent.includes('仅授权1票')
      )
      expect(r).toBeTruthy()
      return r
    })
    fireEvent.click(row)
    await waitFor(() => expect(screen.getByTestId('ticket-board')).toBeInTheDocument())
    expect(screen.queryByTestId('add-lock')).not.toBeInTheDocument()
    expect(screen.queryByTestId('confirm-1')).not.toBeInTheDocument()
  })
})

describe('界面：页面重载与过期冲突', () => {
  it('刷新页面后凭本地令牌恢复登录并展示数据库最新牌板（修订号不回退）', async () => {
    // 先用真实 API 备一张票并推进修订号
    const coord = await loginAs(...ACCOUNTS.coordinator, instances.a)
    const { workers } = await coord('GET', '/api/workers')
    const w1 = workers.find((w) => w.username === 'worker1')
    const created = (
      await coord('POST', '/api/tickets', {
        title: '重载测试票',
        points: ['点一', '点二'],
        workerIds: [w1.id]
      })
    ).snapshot
    const w1Api = await loginAs(...ACCOUNTS.worker1, instances.a)
    const afterConfirm = (
      await w1Api('POST', `/api/tickets/${created.id}/points/${created.points[0].id}/confirm`, {
        expectedRevision: 1
      })
    ).snapshot
    expect(afterConfirm.revision).toBe(2)

    // 界面以 worker1 登录（模拟浏览器刷新：只预置令牌）
    const loginRes = await raw(instances.a, 'POST', '/api/auth/login', {
      body: { username: 'worker1', password: 'worker-123' }
    })
    localStorage.setItem('loto.token', loginRes.token)
    renderApp()
    await waitFor(() => expect(screen.getByTestId('current-user')).toBeInTheDocument())
    const row = await waitFor(() => {
      const r = [...document.querySelectorAll('[data-testid^="ticket-row-"]')].find((x) =>
        x.textContent.includes('重载测试票')
      )
      expect(r).toBeTruthy()
      return r
    })
    fireEvent.click(row)
    await waitFor(() => expect(screen.getByTestId('ticket-board')).toBeInTheDocument())
    // 载入的就是数据库最新：点 1 已确认，修订号 2
    expect(screen.getByTestId('revision-line').textContent).toContain('修订号：2')
    expect(screen.getByTestId('point-state-1').textContent).toContain('已确认')
    expect(screen.getByTestId('point-state-2').textContent).toContain('待确认')
  })

  it('页面过期时点确认：界面收到 409 自动重载为最新快照（点已被他人确认），并提示按最新牌板操作', async () => {
    const coord = await loginAs(...ACCOUNTS.coordinator, instances.a)
    const { workers } = await coord('GET', '/api/workers')
    const w1 = workers.find((w) => w.username === 'worker1')
    const ticket = (
      await coord('POST', '/api/tickets', {
        title: '过期页面票',
        points: ['共同确认点'],
        workerIds: [w1.id]
      })
    ).snapshot

    // 两个浏览器都登录 worker1
    renderApp()
    await login('worker1', 'worker-123')
    const row = await waitFor(() => {
      const r = [...document.querySelectorAll('[data-testid^="ticket-row-"]')].find((x) =>
        x.textContent.includes('过期页面票')
      )
      expect(r).toBeTruthy()
      return r
    })
    fireEvent.click(row)
    await waitFor(() => expect(screen.getByTestId('ticket-board')).toBeInTheDocument())
    expect(screen.getByTestId('revision-line').textContent).toContain('修订号：1')

    // 另一浏览器（真实 API）先确认，数据库推进到 2
    const otherBrowser = await loginAs(...ACCOUNTS.worker1, instances.b)
    await otherBrowser('POST', `/api/tickets/${ticket.id}/points/${ticket.points[0].id}/confirm`, {
      expectedRevision: 1
    })

    // 本浏览器仍停在修订号 1，点确认 -> 409
    fireEvent.click(screen.getByTestId('confirm-1'))

    // 界面自动采纳后端返回的最新快照：点变为已确认，修订号变 2，并展示冲突提示
    await waitFor(() => expect(screen.getByTestId('point-state-1').textContent).toContain('已确认'))
    expect(screen.getByTestId('revision-line').textContent).toContain('修订号：2')
    const boardError = screen.getByTestId('board-error')
    expect(boardError.textContent).toContain('已自动按最新牌板重载')
    expect(boardError).toHaveAttribute('data-error-code', 'STALE_REVISION')
    // 该点不再显示确认按钮
    expect(screen.queryByTestId('confirm-1')).not.toBeInTheDocument()
  })

  it('送电负责人在旧页面点复位而检修人员刚好撤锁：负责人看到 409 后刷新再复位成功', async () => {
    const coord = await loginAs(...ACCOUNTS.coordinator, instances.a)
    const { workers } = await coord('GET', '/api/workers')
    const w1 = workers.find((w) => w.username === 'worker1')
    let snap = (
      await coord('POST', '/api/tickets', {
        title: '负责人旧页面票',
        points: ['唯一必检点'],
        workerIds: [w1.id]
      })
    ).snapshot
    const worker = await loginAs(...ACCOUNTS.worker1, instances.b)
    snap = (await worker('POST', `/api/tickets/${snap.id}/points/${snap.points[0].id}/confirm`, {
      expectedRevision: snap.revision
    })).snapshot
    snap = (await worker('POST', `/api/tickets/${snap.id}/locks`, {
      expectedRevision: snap.revision
    })).snapshot
    // 负责人页面停在“有锁”的修订号 3

    renderApp()
    await login('lead', 'lead-123')
    const r0 = await waitFor(() => {
      const r = [...document.querySelectorAll('[data-testid^="ticket-row-"]')].find((x) =>
        x.textContent.includes('负责人旧页面票')
      )
      expect(r).toBeTruthy()
      return r
    })
    fireEvent.click(r0)
    await waitFor(() => expect(screen.getByTestId('reset-button')).toBeInTheDocument())
    expect(screen.getByTestId('reset-hint').textContent).toContain('个人锁')

    // 检修人员在另一实例撤锁（修订号 3 -> 4）
    await worker('DELETE', `/api/tickets/${snap.id}/locks/mine`, { expectedRevision: snap.revision })

    // 负责人仍点复位（旧修订号 3）→ 409，界面自动重载；再次点击复位成功
    fireEvent.click(screen.getByTestId('reset-button'))
    await waitFor(() => expect(screen.getByTestId('revision-line').textContent).toContain('修订号：4'))
    const board = screen.getByTestId('ticket-board')
    expect(board).toHaveAttribute('data-revision', '4')

    fireEvent.click(screen.getByTestId('reset-button'))
    await waitFor(() => expect(screen.getByTestId('reset-done')).toBeInTheDocument())
    expect(screen.getByTestId('revision-line').textContent).toContain('修订号：5')
  })
})
