// 统一业务异常：全部经错误处理器输出稳定 JSON。
// 稳定结构：{ error: { code, message, details? } }
export class HttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message)
    this.status = status
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export const invalidJson = () =>
  new HttpError(400, 'INVALID_JSON', '请求体不是合法 JSON')

export const invalidInput = (message, details = undefined) =>
  new HttpError(422, 'INVALID_INPUT', message, details)

export const unauthorized = (message = '未登录或会话已失效') =>
  new HttpError(401, 'UNAUTHORIZED', message)

export const forbidden = (message = '无权对该作业票执行此操作') =>
  new HttpError(403, 'FORBIDDEN', message)

export const notFound = () =>
  new HttpError(404, 'TICKET_NOT_FOUND', '作业票不存在')

// 携带过期请求所依据的修订号；处理器会附上数据库最新快照
export const staleRevision = (expected, actual) => {
  const err = new HttpError(409, 'STALE_REVISION', '牌板已被他人更新，请按最新页面重试', {
    expectedRevision: expected,
    actualRevision: actual
  })
  return err
}

export const ticketResetError = () =>
  new HttpError(409, 'TICKET_RESET', '作业票已复位送电，不能再确认隔离点或挂个人锁')

export const noLock = () =>
  new HttpError(409, 'NO_LOCK', '你在该作业票上没有挂着个人锁')

export const lockAlreadyHeld = () =>
  new HttpError(422, 'LOCK_ALREADY_HELD', '你在该作业票上已持有一把个人锁，每人每票限一把')

// 送电前阻断项（送电负责人所见）。state 形如
// { blockers, unconfirmedPointPositions, lockCount }，直接作为 details。
export function resetBlocked(state) {
  return new HttpError(422, 'RESET_BLOCKED', '当前仍不满足送电复位条件', state)
}
