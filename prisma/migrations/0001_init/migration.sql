-- =====================================================================
-- Fast ID System: PostgreSQL schema v1.1
-- Matches API contract 1.0.3-mvp.   Target: PostgreSQL 15 or newer.
-- Run order matters: extensions, enums, functions, tables, indexes, triggers, seed.
-- This file is the first migration (prisma/migrations/0001_init/migration.sql).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fast "contains" search on names and emails

-- ---------------------------------------------------------------------
-- 1. ENUM TYPES
-- ---------------------------------------------------------------------
CREATE TYPE user_role            AS ENUM ('CITIZEN', 'ADMIN', 'AGENT');
CREATE TYPE gender               AS ENUM ('MALE', 'FEMALE');
CREATE TYPE language_code        AS ENUM ('ar', 'en');
CREATE TYPE governorate          AS ENUM (
  'CAIRO', 'GIZA', 'ALEXANDRIA', 'QALYUBIA', 'PORT_SAID', 'SUEZ', 'DAKAHLIA', 'SHARQIA',
  'GHARBIA', 'MONUFIA', 'BEHEIRA', 'KAFR_EL_SHEIKH', 'DAMIETTA', 'ISMAILIA', 'FAIYUM',
  'BENI_SUEF', 'MINYA', 'ASSIUT', 'SOHAG', 'QENA', 'LUXOR', 'ASWAN', 'RED_SEA',
  'NEW_VALLEY', 'MATROUH', 'NORTH_SINAI', 'SOUTH_SINAI');
CREATE TYPE service_availability AS ENUM ('DRAFT', 'PUBLISHED', 'UNPUBLISHED');
CREATE TYPE application_status   AS ENUM (
  'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED',
  'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED');
CREATE TYPE payment_status       AS ENUM ('NOT_REQUIRED', 'UNPAID', 'PAID');
CREATE TYPE decision_outcome     AS ENUM ('APPROVED', 'REJECTED');
CREATE TYPE reject_reason_code   AS ENUM (
  'INCOMPLETE_DOCUMENTS', 'UNCLEAR_DOCUMENTS', 'INVALID_DATA', 'DUPLICATE_REQUEST', 'OTHER');
-- Only ACTIVE and REVOKED are stored. EXPIRED is derived at read time (expires_at < now()).
CREATE TYPE credential_status    AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE delivery_status      AS ENUM (
  'PENDING_ASSIGNMENT', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED_ATTEMPT');
CREATE TYPE delivery_failure_code AS ENUM (
  'CITIZEN_UNAVAILABLE', 'WRONG_ADDRESS', 'CITIZEN_REFUSED', 'OTHER');
CREATE TYPE notification_type    AS ENUM (
  'APPLICATION_SUBMITTED', 'APPLICATION_CANCELLED', 'APPLICATION_UNDER_REVIEW',
  'APPLICATION_APPROVED', 'APPLICATION_REJECTED', 'CREDENTIAL_REVOKED',
  'DELIVERY_ASSIGNED', 'DELIVERY_OUT_FOR_DELIVERY', 'DELIVERY_FAILED_ATTEMPT', 'DELIVERY_COMPLETED');
CREATE TYPE notification_entity  AS ENUM ('APPLICATION', 'DELIVERY');
CREATE TYPE audit_action         AS ENUM (
  'APPLICATION_SUBMITTED', 'APPLICATION_REVIEW_STARTED', 'APPLICATION_APPROVED',
  'APPLICATION_REJECTED', 'APPLICATION_CANCELLED', 'CREDENTIAL_ISSUED', 'CREDENTIAL_REVOKED',
  'DELIVERY_CREATED', 'DELIVERY_ASSIGNED', 'DELIVERY_OUT_FOR_DELIVERY', 'DELIVERY_FAILED',
  'DELIVERY_COMPLETED', 'SERVICE_CREATED', 'SERVICE_UPDATED', 'SERVICE_PUBLISHED',
  'SERVICE_UNPUBLISHED', 'SERVICE_DELETED', 'STAFF_CREATED', 'STAFF_UPDATED',
  'CITIZEN_DEACTIVATED', 'CITIZEN_REACTIVATED', 'PAYMENT_MARKED_PAID_MOCK',
  'PASSWORD_RESET_COMPLETED', 'SETTINGS_UPDATED');
CREATE TYPE audit_entity         AS ENUM (
  'APPLICATION', 'SERVICE', 'CREDENTIAL', 'DELIVERY', 'USER', 'SETTINGS');
CREATE TYPE email_template       AS ENUM (
  'APPLICATION_SUBMITTED', 'APPLICATION_APPROVED', 'APPLICATION_REJECTED', 'CREDENTIAL_REVOKED',
  'DELIVERY_OUT_FOR_DELIVERY', 'DELIVERY_FAILED_ATTEMPT', 'DELIVERY_COMPLETED',
  'PASSWORD_RESET', 'PASSWORD_CHANGED');
CREATE TYPE outbox_status        AS ENUM ('PENDING', 'SENT', 'FAILED');

-- ---------------------------------------------------------------------
-- 2. HELPER FUNCTIONS
-- ---------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION forbid_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;

-- ---------------------------------------------------------------------
-- 3. TABLES
-- ---------------------------------------------------------------------

-- 3.1 users: citizens, admins and agents in one table (role decides which columns apply)
CREATE TABLE users (
  id                   uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  role                 user_role       NOT NULL,
  full_name            varchar(100)    NOT NULL,
  email                varchar(254)    NOT NULL,
  phone                varchar(11)     NOT NULL,
  password_hash        text            NOT NULL,
  national_id          char(14),
  birth_date           date,
  gender               gender,
  governorate          governorate,
  preferred_language   language_code   NOT NULL DEFAULT 'ar',
  is_active            boolean         NOT NULL DEFAULT true,
  must_change_password boolean         NOT NULL DEFAULT false,
  token_version        integer         NOT NULL DEFAULT 0,
  created_at           timestamptz     NOT NULL DEFAULT now(),
  updated_at           timestamptz     NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique        UNIQUE (email),
  CONSTRAINT users_national_id_unique  UNIQUE (national_id),
  CONSTRAINT users_email_lowercase     CHECK (email = lower(email)),
  CONSTRAINT users_phone_format        CHECK (phone ~ '^01[0125][0-9]{8}$'),
  CONSTRAINT users_national_id_format  CHECK (national_id IS NULL OR national_id ~ '^[0-9]{14}$'),
  CONSTRAINT users_citizen_identity    CHECK (
    (role = 'CITIZEN' AND national_id IS NOT NULL AND birth_date IS NOT NULL AND gender IS NOT NULL)
    OR (role <> 'CITIZEN' AND national_id IS NULL AND birth_date IS NULL AND gender IS NULL)),
  CONSTRAINT users_agent_governorate   CHECK (
    (role = 'AGENT' AND governorate IS NOT NULL)
    OR (role <> 'AGENT' AND governorate IS NULL)),
  CONSTRAINT users_token_version_nonneg CHECK (token_version >= 0)
);
CREATE INDEX users_role_active_idx  ON users (role, is_active);
CREATE INDEX users_full_name_trgm   ON users USING gin (full_name gin_trgm_ops);
CREATE INDEX users_email_trgm       ON users USING gin (email gin_trgm_ops);

-- 3.2 password_reset_tokens: single-use, 30-minute tokens (only the SHA-256 hash is stored)
CREATE TABLE password_reset_tokens (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  char(64)     NOT NULL,
  expires_at  timestamptz  NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT prt_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT prt_expiry_after_creation CHECK (expires_at > created_at)
);
CREATE INDEX prt_user_idx ON password_reset_tokens (user_id);

-- 3.3 services: the catalog. `draft` is the editable definition; published copies live in service_versions
CREATE TABLE services (
  id                 varchar(60)           PRIMARY KEY,
  availability       service_availability  NOT NULL DEFAULT 'DRAFT',
  draft              jsonb                 NOT NULL,
  published_version  integer,
  published_at       timestamptz,
  created_at         timestamptz           NOT NULL DEFAULT now(),
  updated_at         timestamptz           NOT NULL DEFAULT now(),
  CONSTRAINT services_id_slug CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(id) >= 3),
  CONSTRAINT services_draft_is_object CHECK (jsonb_typeof(draft) = 'object'),
  CONSTRAINT services_publish_state CHECK ((availability = 'DRAFT') = (published_version IS NULL)),
  CONSTRAINT services_published_pair CHECK ((published_version IS NULL) = (published_at IS NULL)),
  CONSTRAINT services_version_positive CHECK (published_version IS NULL OR published_version >= 1)
);

-- 3.4 service_versions: immutable frozen definitions
CREATE TABLE service_versions (
  service_id    varchar(60)  NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
  version       integer      NOT NULL,
  definition    jsonb        NOT NULL,
  published_at  timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (service_id, version),
  CONSTRAINT sv_version_positive CHECK (version >= 1),
  CONSTRAINT sv_definition_is_object CHECK (jsonb_typeof(definition) = 'object')
);
-- the live version must exist (checked at commit time because publish writes both rows together)
ALTER TABLE services
  ADD CONSTRAINT services_published_version_fk
  FOREIGN KEY (id, published_version) REFERENCES service_versions (service_id, version)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER sv_immutable BEFORE UPDATE OR DELETE ON service_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- 3.5 applications
CREATE SEQUENCE application_number_seq START 1;
CREATE TABLE applications (
  id                   uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
  application_number   varchar(20)         NOT NULL DEFAULT (
    'APP-' || to_char(now() AT TIME ZONE 'Africa/Cairo', 'YYYY') || '-' ||
    lpad(nextval('application_number_seq')::text, 6, '0')),
  citizen_id           uuid                NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  service_id           varchar(60)         NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
  service_version      integer,
  status               application_status  NOT NULL DEFAULT 'DRAFT',
  data                 jsonb               NOT NULL DEFAULT '{}'::jsonb,
  delivery_address     jsonb,
  payment_status       payment_status      NOT NULL,
  payment_amount       integer             NOT NULL DEFAULT 0,
  paid_at              timestamptz,
  payment_reference    varchar(40),
  submitted_at         timestamptz,
  due_at               timestamptz,
  decided_at           timestamptz,
  decided_by           uuid                REFERENCES users (id) ON DELETE RESTRICT,
  decision_outcome     decision_outcome,
  decision_reason_code reject_reason_code,
  decision_reason      text,
  created_at           timestamptz         NOT NULL DEFAULT now(),
  updated_at           timestamptz         NOT NULL DEFAULT now(),
  CONSTRAINT applications_number_unique UNIQUE (application_number),
  -- MATCH SIMPLE allows NULL service_version on DRAFT and enforces valid version once submitted
  CONSTRAINT applications_service_version_fk
    FOREIGN KEY (service_id, service_version)
    REFERENCES service_versions (service_id, version) ON DELETE RESTRICT,
  CONSTRAINT applications_data_is_object CHECK (jsonb_typeof(data) = 'object'),
  CONSTRAINT applications_address_is_object CHECK (delivery_address IS NULL OR jsonb_typeof(delivery_address) = 'object'),
  CONSTRAINT applications_amount_nonneg CHECK (payment_amount >= 0),
  CONSTRAINT applications_payment_consistent CHECK (
    ((payment_status = 'NOT_REQUIRED') = (payment_amount = 0))
    AND ((payment_status = 'PAID') = (paid_at IS NOT NULL))),
  CONSTRAINT applications_submit_consistent CHECK (
    ((status = 'DRAFT') = (submitted_at IS NULL))
    AND ((status = 'DRAFT') = (service_version IS NULL))
    AND (submitted_at IS NULL OR due_at IS NOT NULL)),
  CONSTRAINT applications_decision_pair CHECK (
    (decision_outcome IS NULL) = (decided_at IS NULL)
    AND (decided_at IS NULL) = (decided_by IS NULL)),
  CONSTRAINT applications_reject_reason CHECK (
    (decision_outcome = 'REJECTED' AND decision_reason_code IS NOT NULL AND decision_reason IS NOT NULL)
    OR (decision_outcome IS DISTINCT FROM 'REJECTED' AND decision_reason_code IS NULL AND decision_reason IS NULL)),
  CONSTRAINT applications_status_vs_outcome CHECK (
    (status IN ('APPROVED', 'OUT_FOR_DELIVERY', 'DELIVERED') AND decision_outcome = 'APPROVED')
    OR (status = 'REJECTED' AND decision_outcome = 'REJECTED')
    OR (status IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CANCELLED') AND decision_outcome IS NULL))
);
-- one active application per (citizen, service)
CREATE UNIQUE INDEX applications_one_active_per_service
  ON applications (citizen_id, service_id)
  WHERE status IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'OUT_FOR_DELIVERY');
CREATE INDEX applications_citizen_status_idx ON applications (citizen_id, status, created_at DESC);
CREATE INDEX applications_status_submitted_idx ON applications (status, submitted_at DESC) WHERE status <> 'DRAFT';
CREATE INDEX applications_service_idx ON applications (service_id);
CREATE INDEX applications_open_due_idx ON applications (due_at) WHERE status IN ('SUBMITTED', 'UNDER_REVIEW');
CREATE INDEX applications_number_prefix_idx ON applications (application_number text_pattern_ops);
CREATE INDEX applications_governorate_idx
  ON applications ((delivery_address->>'governorate'))
  WHERE status <> 'DRAFT';

-- 3.6 application_status_history: append-only timeline
-- Drafts write no rows here; the first row is inserted on submit so draft deletion via CASCADE never hits ash_append_only.
CREATE TABLE application_status_history (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id  uuid                NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  status          application_status  NOT NULL,
  created_at      timestamptz         NOT NULL DEFAULT now(),   -- API field name: at
  by_user_id      uuid                REFERENCES users (id) ON DELETE RESTRICT,   -- NULL = system
  citizen_note    text,                                                           -- shown to the citizen
  staff_note      text                                                            -- staff only
);
CREATE INDEX ash_application_idx ON application_status_history (application_id, created_at, id);
CREATE TRIGGER ash_append_only BEFORE UPDATE OR DELETE ON application_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- 3.7 attachments: file metadata (bytes live in the storage driver, never in the database)
CREATE TABLE attachments (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid          NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  requirement_key  varchar(40)   NOT NULL,
  original_name    varchar(255)  NOT NULL,
  mime_type        varchar(100)  NOT NULL,
  size_bytes       integer       NOT NULL,
  storage_key      text          NOT NULL,
  uploaded_at      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT attachments_one_per_requirement UNIQUE (application_id, requirement_key),
  CONSTRAINT attachments_storage_key_unique UNIQUE (storage_key),
  CONSTRAINT attachments_size_positive CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  CONSTRAINT attachments_mime_allowed CHECK (mime_type IN ('image/jpeg', 'image/png', 'application/pdf'))
);

-- 3.8 credentials: the issued record (created automatically on approval)
CREATE TABLE credentials (
  id              uuid               PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid               NOT NULL REFERENCES applications (id) ON DELETE RESTRICT,
  holder_id       uuid               NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  service_id      varchar(60)        NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
  holder_name     varchar(100)       NOT NULL,          -- name snapshot at issuance
  number          varchar(14)        NOT NULL,
  qr_token        varchar(64)        NOT NULL,
  status          credential_status  NOT NULL DEFAULT 'ACTIVE',
  issued_at       timestamptz        NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  revoked_at      timestamptz,
  revoked_by      uuid               REFERENCES users (id) ON DELETE RESTRICT,
  revoked_reason  text,
  CONSTRAINT credentials_application_unique UNIQUE (application_id),
  CONSTRAINT credentials_number_unique UNIQUE (number),
  CONSTRAINT credentials_qr_token_unique UNIQUE (qr_token),
  CONSTRAINT credentials_number_format CHECK (number ~ '^CRD-[0-9A-Z]{10}$'),
  CONSTRAINT credentials_expiry_after_issue CHECK (expires_at IS NULL OR expires_at > issued_at),
  CONSTRAINT credentials_revocation CHECK (
    (status = 'REVOKED' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_reason IS NOT NULL)
    OR (status = 'ACTIVE' AND revoked_at IS NULL AND revoked_by IS NULL AND revoked_reason IS NULL))
);
CREATE INDEX credentials_holder_idx ON credentials (holder_id, issued_at DESC);

-- 3.9 deliveries
CREATE TABLE deliveries (
  id                    uuid                   PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid                   NOT NULL REFERENCES applications (id) ON DELETE RESTRICT,
  agent_id              uuid                   REFERENCES users (id) ON DELETE RESTRICT,
  status                delivery_status        NOT NULL DEFAULT 'PENDING_ASSIGNMENT',
  attempts              integer                NOT NULL DEFAULT 0,
  delivery_code         char(6),               -- only while OUT_FOR_DELIVERY; the citizen must be able to see it
  code_failed_tries     smallint               NOT NULL DEFAULT 0,
  assigned_at           timestamptz,
  out_for_delivery_at   timestamptz,
  delivered_at          timestamptz,
  last_failure_code     delivery_failure_code,
  last_failure_reason   text,
  last_failure_at       timestamptz,
  created_at            timestamptz            NOT NULL DEFAULT now(),
  updated_at            timestamptz            NOT NULL DEFAULT now(),
  CONSTRAINT deliveries_application_unique UNIQUE (application_id),
  CONSTRAINT deliveries_attempts_nonneg CHECK (attempts >= 0),
  CONSTRAINT deliveries_code_format CHECK (delivery_code IS NULL OR delivery_code ~ '^[0-9]{6}$'),
  CONSTRAINT deliveries_code_tries_range CHECK (code_failed_tries BETWEEN 0 AND 5),
  CONSTRAINT deliveries_agent_vs_status CHECK ((status = 'PENDING_ASSIGNMENT') = (agent_id IS NULL)),
  CONSTRAINT deliveries_code_vs_status CHECK ((status = 'OUT_FOR_DELIVERY') = (delivery_code IS NOT NULL)),
  CONSTRAINT deliveries_delivered_at CHECK ((status = 'DELIVERED') = (delivered_at IS NOT NULL)),
  CONSTRAINT deliveries_out_at CHECK (status <> 'OUT_FOR_DELIVERY' OR out_for_delivery_at IS NOT NULL),
  CONSTRAINT deliveries_failure_pair CHECK ((last_failure_code IS NULL) = (last_failure_at IS NULL)),
  CONSTRAINT deliveries_failure_reason CHECK (last_failure_code IS DISTINCT FROM 'OTHER' OR last_failure_reason IS NOT NULL)
);
CREATE INDEX deliveries_agent_status_idx  ON deliveries (agent_id, status, assigned_at);
CREATE INDEX deliveries_status_created_idx ON deliveries (status, created_at DESC);

-- 3.10 notifications (in-app)
CREATE TABLE notifications (
  id           uuid                 PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid                 NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type         notification_type    NOT NULL,
  title        jsonb                NOT NULL,     -- { "ar": "...", "en": "..." }
  body         jsonb                NOT NULL,
  entity_type  notification_entity  NOT NULL,
  entity_id    uuid                 NOT NULL,
  is_read      boolean              NOT NULL DEFAULT false,
  read_at      timestamptz,
  created_at   timestamptz          NOT NULL DEFAULT now(),
  CONSTRAINT notifications_read_pair CHECK (is_read = (read_at IS NOT NULL)),
  CONSTRAINT notifications_localized CHECK (
    jsonb_typeof(title) = 'object' AND title ? 'ar' AND title ? 'en'
    AND jsonb_typeof(body) = 'object' AND body ? 'ar' AND body ? 'en')
);
CREATE INDEX notifications_user_read_idx ON notifications (user_id, is_read, created_at DESC);

-- 3.11 audit_logs: append-only, written in the same transaction as the action it records
CREATE TABLE audit_logs (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id     uuid          REFERENCES users (id) ON DELETE RESTRICT,   -- NULL = system
  action       audit_action  NOT NULL,
  entity_type  audit_entity  NOT NULL,
  entity_id    varchar(64)   NOT NULL,                                   -- uuid, service slug or 'singleton'
  metadata     jsonb         NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT audit_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX audit_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_entity_idx  ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_actor_idx   ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_action_idx  ON audit_logs (action, created_at DESC);
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- 3.12 email_outbox: transactional outbox. Rows are inserted in the same transaction as the business
--      change; a background worker sends them, so an email problem never breaks a request.
CREATE TABLE email_outbox (
  id               uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email         varchar(254)    NOT NULL,
  to_user_id       uuid            REFERENCES users (id) ON DELETE SET NULL,
  template         email_template  NOT NULL,
  language         language_code   NOT NULL,
  payload          jsonb           NOT NULL DEFAULT '{}'::jsonb,   -- template variables (never passwords)
  status           outbox_status   NOT NULL DEFAULT 'PENDING',
  attempts         integer         NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz     NOT NULL DEFAULT now(),
  locked_until     timestamptz,    -- short worker lease so external HTTP sends never hold a DB lock
  last_error       text,
  created_at       timestamptz     NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  CONSTRAINT outbox_attempts_nonneg CHECK (attempts >= 0),
  CONSTRAINT outbox_sent_pair CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
);
CREATE INDEX outbox_pending_idx ON email_outbox (next_attempt_at) WHERE status = 'PENDING';

-- 3.13 settings: singleton row
CREATE TABLE settings (
  id             text          PRIMARY KEY DEFAULT 'singleton',
  support_email  varchar(254),
  support_phone  varchar(11),
  announcement   jsonb,
  updated_by     uuid          REFERENCES users (id) ON DELETE SET NULL,
  updated_at     timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT settings_singleton CHECK (id = 'singleton'),
  CONSTRAINT settings_phone_format CHECK (support_phone IS NULL OR support_phone ~ '^01[0125][0-9]{8}$'),
  CONSTRAINT settings_announcement_localized CHECK (
    announcement IS NULL OR (jsonb_typeof(announcement) = 'object' AND announcement ? 'ar' AND announcement ? 'en'))
);

-- ---------------------------------------------------------------------
-- 4. updated_at TRIGGERS
-- ---------------------------------------------------------------------
CREATE TRIGGER users_updated_at        BEFORE UPDATE ON users        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER services_updated_at     BEFORE UPDATE ON services     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER applications_updated_at BEFORE UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER deliveries_updated_at   BEFORE UPDATE ON deliveries   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER settings_updated_at     BEFORE UPDATE ON settings     FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 5. REQUIRED SEED (the app also upserts this on boot)
-- ---------------------------------------------------------------------
INSERT INTO settings (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING;
