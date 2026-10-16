-- =====================================================================
-- HR Stock Request - Telegram Mini App
-- Database: PostgreSQL 13+   (encoding UTF8, so Khmer text works)
-- Run:  psql -U postgres -c "CREATE DATABASE hr_stock WITH ENCODING 'UTF8';"
--       psql -U postgres -d hr_stock -f schema.sql
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. Clean re-run (DEV ONLY: this wipes data. Delete section 0 before re-running on a live DB)
-- ---------------------------------------------------------------------
DROP VIEW     IF EXISTS v_requests, v_monthly_stats CASCADE;
DROP TABLE    IF EXISTS notifications, requests, request_counters,
                        users, uoms, departments CASCADE;
DROP TYPE     IF EXISTS request_status, user_role CASCADE;
DROP FUNCTION IF EXISTS set_request_no(), set_updated_at() CASCADE;

-- ---------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------
CREATE TYPE request_status AS ENUM ('Open', 'Close');
CREATE TYPE user_role      AS ENUM ('requester', 'hr_admin', 'admin');

-- ---------------------------------------------------------------------
-- 2. Lookup tables (feed the Department and UOM dropdowns)
-- ---------------------------------------------------------------------
CREATE TABLE departments (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL UNIQUE,
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE
);

CREATE TABLE uoms (
    id          SERIAL PRIMARY KEY,
    code        VARCHAR(20)  NOT NULL UNIQUE,   -- PCS, BOX, PACK ...
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE
);

-- ---------------------------------------------------------------------
-- 3. Users (linked to Telegram account)
-- ---------------------------------------------------------------------
CREATE TABLE users (
    id             SERIAL PRIMARY KEY,
    telegram_id    BIGINT       NOT NULL UNIQUE,   -- Telegram user id (needs BIGINT)
    telegram_user  VARCHAR(64),                    -- @username (can change / be null)
    full_name      VARCHAR(150) NOT NULL,
    position       VARCHAR(150),                   -- e.g. "Procurement - IAES"
    department_id  INT REFERENCES departments(id) ON UPDATE CASCADE,
    role           user_role    NOT NULL DEFAULT 'requester',
    is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_department ON users(department_id);

-- ---------------------------------------------------------------------
-- 4. Request number counter  ->  format "MMYY-N"  (e.g. 1026-13)
--    One row per month; the counter restarts each month.
-- ---------------------------------------------------------------------
CREATE TABLE request_counters (
    period      CHAR(4) PRIMARY KEY,   -- 'MMYY', e.g. '1026'
    last_number INT     NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- 5. Stock requests (main table)
-- ---------------------------------------------------------------------
CREATE TABLE requests (
    id              BIGSERIAL PRIMARY KEY,
    request_no      VARCHAR(20) UNIQUE,                    -- auto-filled by trigger
    requester_id    INT          NOT NULL REFERENCES users(id),
    requester_name  VARCHAR(150) NOT NULL,                 -- snapshot at request time
    position        VARCHAR(150),                          -- snapshot
    department_id   INT          NOT NULL REFERENCES departments(id),
    item            VARCHAR(255) NOT NULL,
    qty             NUMERIC(12,2) NOT NULL DEFAULT 1 CHECK (qty > 0),
    uom_id          INT          NOT NULL REFERENCES uoms(id),
    total           NUMERIC(12,2) NOT NULL DEFAULT 1 CHECK (total >= 0),  -- defaults to qty in UI
    request_date    DATE         NOT NULL DEFAULT CURRENT_DATE,
    request_time    TIME         NOT NULL DEFAULT LOCALTIME(0),
    status          request_status NOT NULL DEFAULT 'Open',
    remark          TEXT         NOT NULL DEFAULT 'N/A',
    closed_at       TIMESTAMPTZ,                           -- set when status -> Close
    created_by      INT REFERENCES users(id),
    updated_by      INT REFERENCES users(id),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_requests_date       ON requests(request_date DESC);
CREATE INDEX idx_requests_status     ON requests(status);
CREATE INDEX idx_requests_requester  ON requests(requester_id);
CREATE INDEX idx_requests_department ON requests(department_id);
-- Fast search by item / name (Search box in the UI)
CREATE INDEX idx_requests_search ON requests
    USING gin (to_tsvector('simple',
        coalesce(item,'') || ' ' || coalesce(requester_name,'') || ' ' || coalesce(request_no,'')));

-- ---------------------------------------------------------------------
-- 6. Telegram notification log (for "Send Telegram notification")
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
    id           BIGSERIAL PRIMARY KEY,
    request_id   BIGINT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    chat_id      BIGINT NOT NULL,                -- group / user chat the message went to
    message_id   BIGINT,                         -- Telegram message id returned by the Bot API
    success      BOOLEAN NOT NULL DEFAULT TRUE,
    error_text   TEXT,
    sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_request ON notifications(request_id);

-- ---------------------------------------------------------------------
-- 7. Triggers
-- ---------------------------------------------------------------------

-- 7a. updated_at + closed_at maintenance
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := NOW();
    IF TG_TABLE_NAME = 'requests' THEN
        IF NEW.status = 'Close' AND (OLD.status IS DISTINCT FROM 'Close') THEN
            NEW.closed_at := NOW();
        ELSIF NEW.status = 'Open' THEN
            NEW.closed_at := NULL;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated
    BEFORE UPDATE ON users    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_requests_updated
    BEFORE UPDATE ON requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 7b. Auto-generate request_no = MMYY-N  (atomic, safe for concurrent inserts)
CREATE FUNCTION set_request_no() RETURNS trigger AS $$
DECLARE
    p   CHAR(4);
    n   INT;
BEGIN
    IF NEW.request_no IS NULL THEN
        p := to_char(NEW.request_date, 'MMYY');
        INSERT INTO request_counters (period, last_number)
             VALUES (p, 1)
        ON CONFLICT (period)
             DO UPDATE SET last_number = request_counters.last_number + 1
        RETURNING last_number INTO n;
        NEW.request_no := p || '-' || n;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_requests_no
    BEFORE INSERT ON requests FOR EACH ROW EXECUTE FUNCTION set_request_no();

-- ---------------------------------------------------------------------
-- 8. Views used directly by the API
-- ---------------------------------------------------------------------

-- 8a. Request list with joined names (list + search + Telegram message)
CREATE VIEW v_requests AS
SELECT r.id, r.request_no, r.requester_id, r.requester_name, r.position,
       r.department_id, d.name AS department,
       r.item, r.qty, r.uom_id, u.code AS uom, r.total,
       r.request_date, r.request_time, r.status, r.remark,
       r.closed_at, r.created_at, r.updated_at
FROM requests r
JOIN departments d ON d.id = r.department_id
JOIN uoms        u ON u.id = r.uom_id;

-- 8b. Dashboard cards: "Total this month / Open / Closed"
CREATE VIEW v_monthly_stats AS
SELECT date_trunc('month', request_date)::date AS month,
       requester_id,
       COUNT(*)                                       AS total,
       COUNT(*) FILTER (WHERE status = 'Open')        AS open_count,
       COUNT(*) FILTER (WHERE status = 'Close')       AS closed_count
FROM requests
GROUP BY 1, 2;

-- ---------------------------------------------------------------------
-- 9. Seed data
-- ---------------------------------------------------------------------
INSERT INTO departments (name) VALUES
    ('HR/Admin'), ('Procurement'), ('Finance'), ('IT'), ('Operations'), ('Sales') , ('Marketing'), ('Logistics'), ('Customer Service'),
    ('Research & Development'), ('Quality Assurance'), ('Production'), ('Maintenance'), ('Supply Chain'), ('Business Development'),
    ('Accounting'), ('Human Resources'), ('Project Management'), ('Engineering'), ('Design'), ('Customer Support'), ('Data Analysis'), ('Content Creation'), ('Event Planning'), ('Strategic Planning'),
    ('Operations Management'), ('Business Intelligence'), ('Digital Marketing'), ('E-commerce'), ('Social Media Management'), ('Public Affairs'), ('Corporate Communications'), ('Training & Development'),
    ('Facilities Management'), ('Procurement & Supply Chain'), ('System Support');

INSERT INTO uoms (code) VALUES
    ('PCS'), ('BOX'), ('PACK'), ('SET'), ('ROLL'), ('BOTTLE'), ('REAM');

-- First HR admin (Telegram id 2018611029). More admins: UPDATE users SET role='hr_admin' WHERE telegram_id=...;
INSERT INTO users (telegram_id, telegram_user, full_name, position, department_id, role)
VALUES (2018611029, 'RA_Hengmeng', 'RA Hengmeng', 'HR/Admin Officer',
        (SELECT id FROM departments WHERE name = 'HR/Admin'), 'hr_admin');

COMMIT;

-- Quick checks:
--   SELECT * FROM users;
--   SELECT * FROM v_requests;
