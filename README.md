# 检修隔离牌板（LOTO 全栈系统）

设备检修期间的上锁挂牌控制台：协调员开票、检修人员确认必检隔离点并挂/撤**自己唯一的个人锁**、
送电负责人在条件全部满足后复位送电。**两个 API 实例共享同一个 PostgreSQL 裁决**，
任何旧页面或并发请求都不可能把仍挂着个人锁的设备误置为“可送电”。

## 账号（演示数据）

| 角色 | 用户名 | 口令 | 权限 |
| --- | --- | --- | --- |
| 协调员 | `coordinator` | `coord-123` | 新建作业票，指定 1～20 个隔离点与授权人员 |
| 检修人员 | `worker1` | `worker-123` | 仅在**自己被授权的票**上确认隔离点、挂/撤自己唯一一把锁 |
| 检修人员 | `worker2` | `worker-123` | 同上 |
| 检修人员 | `worker3` | `worker-123` | 同上 |
| 送电负责人 | `lead` | `lead-123` | 仅在全部点已确认、锁数为 0、票仍在检修时复位 |

## 业务规则

- 协调员可新建票，每张票 **1～20 个必检隔离点**，授权人员至少一名（只能是工作人员）。
- 检修人员只能在授权票上：确认隔离点、挂锁、撤锁；每人在每张票上最多一把锁（DB 唯一约束兜底）。
- 送电负责人复位条件：`status = ACTIVE` **且** 全部必检点已确认 **且** 个人锁数为 0。
- 复位与复位所依据的快照**在同一数据库事务中原子提交**；复位后票进入终态 `RESET`，
  任何迟到的确认、挂锁请求都被拒绝（`TICKET_RESET`）。
- 每次变更必须携带**页面所见修订号** `expectedRevision`（大整数单调递增）：
  - 过期请求 → `409 STALE_REVISION`，响应里带数据库**最新快照**，界面自动按最新牌板重载；
  - 越权 → `403 FORBIDDEN`；业务条件不满足（如仍有锁）→ `422 RESET_BLOCKED` 并附阻断项；
  - 任何失败都不改动当前牌板（事务回滚）。
- 所有错误均为稳定 JSON：`{ "error": { "code", "message", "details?" } }`，无假接口、无内存态裁决。

## 并发裁决如何防住“撤最后一锁 × 复位”

所有票级变更在事务内执行：

1. `SELECT ... FROM tickets WHERE id = $1 FOR UPDATE` 锁住票行；
2. 在同一事务内重新读取隔离点（`FOR SHARE`）与个人锁（`FOR SHARE`），计算阻断项；
3. 条件满足才更新状态并把 `revision = revision + 1`，整体提交。

因此“撤锁”与“复位”在 PostgreSQL 内被票行锁严格串行，二者依据同一旧修订号时：

- 撤锁先提交 → 复位依据已过期，回滚后读到的最新牌板锁数为 0、修订号已推进 →
  返回 `409 STALE_REVISION` + 最新快照；负责人按快照重试一次，复位成功；
- 复位先占锁 → 当时锁仍在，`RESET_BLOCKED` 回滚（绝不送电）；撤锁随后成功；
  负责人仍收到带最新快照的 `409`。

**复位在有锁时永远不会成功；复位最多成功一次；败方响应中的阻断项/终态与数据库逐项一致。**

## 目录

```
server/            Fastify API、迁移、种子、裁决（PostgreSQL 事务 + 单调修订号）
  app.js           路由与统一稳定 JSON 错误
  repo.js          票行锁事务原语、快照构建、阻断项计算
  migrations/      SQL（幂等，咨询锁保护并发启动）
src/               React 页面（登录、建票、牌板；409 自动重载）
test/              Vitest：真实数据库上的两实例竞争测试 + 界面重载测试
deploy/nginx.conf  两个 API 实例的轮询反代与 SPA 托管
```

## 用 Docker Compose 运行

```bash
# 页面端口由 WEB_PORT 控制（默认 8088）
WEB_PORT=8088 docker compose up --build
```

打开 <http://localhost:8088>，用上表账号登录。
两个 API 实例 `api1`/`api2` 由 nginx 轮询，裁决全部落在 `db`（PostgreSQL）。

### 一次性验收服务 verify

`verify` 服务对真实数据库执行：迁移 → 种子 → 完整 Vitest（含两实例竞争、界面重载），跑完即退出：

```bash
docker compose --profile verify run --rm verify
```

## 本地开发

需要可达的 PostgreSQL（测试也可自动拉起嵌入式 PostgreSQL）：

```bash
npm install
# 可选：export DATABASE_URL=postgres://loto:loto@localhost:5432/loto_board
npm run migrate
npm run seed
npm run dev        # 同时起 Vite(5173) 与 Fastify(8080)，/api 自动代理
```

### 测试

```bash
npm test
```

未提供 `DATABASE_URL` 且本机 5432 不可达时，测试会自动下载并启动一个**真实的嵌入式 PostgreSQL**
（数据落在已被 .gitignore 排除的 `.embedded-postgres/`）。测试包括：

- `test/races.test.js`：两实例双复位、撤最后一锁 × 复位交错、跨实例修订号裁决、复位后迟到请求；
  断言“复位最多成功一次”“败方所见快照与数据库一致”；
- `test/api.test.js`：角色/授权边界、1～20 点校验、票全生命周期、稳定错误 JSON；
- `test/ui.test.jsx`：React 真实渲染，覆盖浏览器刷新恢复、旧页面 409 后自动重载为最新牌板。
