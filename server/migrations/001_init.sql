-- 初始结构：作业票 / 必检隔离点 / 授权人员 / 个人锁 / 单调修订号
-- 幂等：每个对象都 IF NOT EXISTS，迁移可被两个 API 实例并发执行
-- （外层由 pg_advisory_xact_lock 串行化）。

DO $$ BEGIN
  CREATE TYPE ticket_status AS ENUM ('ACTIVE', 'RESET');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS users (
    id          uuid PRIMARY KEY,
    username    text NOT NULL UNIQUE,
    display_name text NOT NULL,
    role        text NOT NULL CHECK (role IN ('COORDINATOR', 'WORKER', 'ENERGIZE_LEAD')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_secrets (
    user_id  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- scrypt 结果：salt:hash（均为 hex）
    salt     text NOT NULL,
    hash     text NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token      text PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS tickets (
    id         uuid PRIMARY KEY,
    title      text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
    status     ticket_status NOT NULL DEFAULT 'ACTIVE',
    revision   bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    reset_at   timestamptz
);

CREATE TABLE IF NOT EXISTS ticket_points (
    id          uuid PRIMARY KEY,
    ticket_id   uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    position    integer NOT NULL CHECK (position BETWEEN 1 AND 20),
    label       text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 100),
    confirmed_by uuid REFERENCES users(id),
    confirmed_at timestamptz,
    UNIQUE (ticket_id, position)
);

CREATE INDEX IF NOT EXISTS ticket_points_ticket_id_idx ON ticket_points(ticket_id);

-- 票上的授权工作人员（只有他们能确认必检点、挂/撤个人锁）
CREATE TABLE IF NOT EXISTS ticket_assignments (
    ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id   uuid NOT NULL REFERENCES users(id),
    PRIMARY KEY (ticket_id, user_id)
);

CREATE INDEX IF NOT EXISTS ticket_assignments_user_id_idx ON ticket_assignments(user_id);

-- 个人锁：同一作业票内每人最多一把（DB 约束兜底，代码先在票行锁内判重）
CREATE TABLE IF NOT EXISTS personal_locks (
    id         uuid PRIMARY KEY,
    ticket_id  uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id),
    locked_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (ticket_id, user_id)
);

CREATE INDEX IF NOT EXISTS personal_locks_ticket_id_idx ON personal_locks(ticket_id);
