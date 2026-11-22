# Fast ID System — Backend API (`Fast-ID-api`)

REST API for the Fast ID System built with **NestJS 10**, **TypeScript (`strict: true`)**, **PostgreSQL 15+**, and **Prisma 6** (database-first). Implements all **63 endpoints** and **57 error codes** specified in `docs/Fast_ID_API_Contract.md` (v1.0.3-mvp).

## Prerequisites

- Node.js `>= 20` LTS
- Docker & Docker Compose (PostgreSQL 15+)

## Quick Start (Clean Checkout)

```bash
# 1. Start PostgreSQL 15
docker compose up -d --wait

# 2. Configure environment variables
cp .env.example .env
# Edit .env with your local values (never commit .env or real secrets)

# 3. Install dependencies
npm ci

# 4. Apply SQL migrations (database-first; never run `prisma migrate dev`)
npm run migrate

# 5. Start the API in watch mode
npm run start:dev
```

On first boot, `SeedService` ensures the `settings` singleton exists and creates the initial `ADMIN` account from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (with `mustChangePassword: true`) if no `ADMIN` exists in the database.

## Architecture & Security Controls

- **HTTP pipeline (`src/app.setup.ts`, `src/app.module.ts`):**
  1. `helmet` security headers (`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS outside local dev)
  2. `cookie-parser`, server-generated `X-Request-Id` (client header ignored)
  3. Strict exact-match CORS allow-list (`CORS_ORIGINS`, never `*`, `credentials: true`, exposed `Retry-After`, `X-Request-Id`, `Content-Disposition`)
  4. Write `Content-Type` enforcement (D-24: `415 UNSUPPORTED_MEDIA_TYPE` on disallowed media types) & 100 KB JSON body limit (`413 PAYLOAD_TOO_LARGE`)
  5. Guard order: `OriginGuard` (all state-changing writes) -> `AppThrottlerGuard` (IP rate limits) -> `AuthGuard` (HS256 `fid_session` httpOnly cookie + live `is_active` & `token_version` check) -> `UserRateLimitGuard` -> `PasswordChangeGuard` -> `RolesGuard`
  6. Strict whitelist `ValidationPipe` (`400 UNKNOWN_FIELD` / `400 VALIDATION_ERROR` with `details`)
  7. Uniform `{ success, data, meta? }` / `{ success: false, error }` envelope (`ResponseEnvelopeInterceptor` & `AllExceptionsFilter`) except binary attachment downloads (§4.10), SSE streams (§6.6), and CSV exports (§7.2)
  8. `CacheControlInterceptor` (`Cache-Control: no-store` default + `Vary: Origin`, with explicit public cache exceptions in §0.15)
  9. `nestjs-pino` structured request logging with PII/cookie/token/password redaction
  10. Graceful shutdown hooks (`app.enableShutdownHooks()`): drains HTTP, closes SSE streams, stops scheduled jobs, disconnects Prisma.
- **Passwords & Tokens:** `argon2id` password hashing; dummy hash verification on login for timing protection; SHA-256 hashed single-use password reset tokens; 32-byte random QR tokens; constant-time 6-digit delivery code comparison with persisted 5-try lock.
- **Attachments & Exports:** Magic-byte sniffing (JPEG/PNG/PDF), private storage outside web root, authenticated streaming with `Content-Security-Policy: default-src 'none'; sandbox` and RFC 5987 UTF-8 `Content-Disposition`, UTF-8 BOM CSV exports with formula-injection neutralization (`=`, `+`, `-`, `@`, `\t`, `\r`).
- **Concurrency & Workflow:** Single status-writer (`ApplicationWorkflowService.transition`), global lock order (`application -> delivery -> credential -> users -> advisory locks`), `FOR NO KEY UPDATE` on `users` to prevent FK deadlocks, advisory locks (`assign:<governorate>`, `staff:admin_active`), lease-based transactional email outbox worker (`FOR UPDATE SKIP LOCKED` + `locked_until`), and daily 03:00 `Africa/Cairo` cleanup job.

## Rate Limits (Contract §0.13)

All in-memory rate-limiters are bounded (50,000-entry cap with periodic TTL pruning) and return `429 RATE_LIMITED` with a `Retry-After` header in seconds:

| Endpoint | Limit |
|---|---|
| `POST /api/v1/auth/login` | 10 / 15 min per IP + 5 failed attempts / 15 min per (IP + identifier) |
| `POST /api/v1/auth/register` | 5 / hour per IP |
| `POST /api/v1/auth/forgot-password` | 3 / hour per IP + 3 / hour per email |
| `POST /api/v1/auth/reset-password` | 10 / hour per IP |
| `POST /api/v1/auth/change-password` | 5 / 15 min per user |
| `GET /api/v1/verify/:qrToken` | 30 / min per IP |
| `POST /api/v1/applications/:id/attachments` | 30 / 10 min per user |
| `POST /api/v1/agent/deliveries/:id/deliver` | 20 / min per user (+ 5-try per-delivery lock) |
| `GET /api/v1/admin/applications/export` | 5 / min per user |
| All other endpoints (default) | 120 / min per IP |
| `GET /api/v1/notifications/stream` | Max 3 concurrent SSE streams per user |

## Database Migration Rules

- `prisma/migrations/0001_init/migration.sql` is `db/schema.sql` copied verbatim.
- Future schema changes must be authored manually as timestamped SQL files under `prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql`.
- Apply migrations with `npm run migrate` (`prisma migrate deploy`), then regenerate Prisma models with `npm run db:pull` (`prisma db pull && prisma generate`).
- Note for Prisma 6 `db pull`: PostgreSQL's deferred composite FK `services_published_version_fk` (`(id, published_version) -> service_versions(service_id, version)`) is introspected as a one-to-one relation without `@@unique([id, published_version])`. Keep the back-relation on `service_versions` (`services_services_id_published_versionToservice_versions`) as `services[]` in `prisma/schema.prisma` before running `prisma generate`.
- **Never** run `prisma migrate dev` and **never** edit an already-applied migration.

## Verification & Quality Gates

```bash
npm run format      # Prettier check/write
npm run lint        # ESLint strict check
npm run build       # TypeScript strict NestJS build
npm test            # Unit test suites (includes 57-code error registry vs contract check)
npm run test:e2e    # Full e2e suites against real PostgreSQL 15 (includes 63-endpoint conformance, hardening & demo scenario)
```

## Demo Seed (Local Development & Graduation Demo Only)

To populate a non-production database with 3 published bilingual services (`national-id`, `driving-license`, `birth-certificate`) and 4 ready-to-use demo accounts, set `DEMO_SEED_PASSWORD` (at least 8 characters, containing a letter and a digit) and run:

```bash
# Bash / macOS / Linux
DEMO_SEED_PASSWORD="YourDemoPassword1!" npm run seed:demo

# PowerShell (Windows)
$env:DEMO_SEED_PASSWORD = "YourDemoPassword1!"; npm run seed:demo
```

The script is idempotent and refuses to run when `NODE_ENV=production`. Demo accounts created:
- **Admin:** `demo.admin@example.com`
- **Cairo Agent:** `demo.agent.cairo@example.com` (`CAIRO`)
- **Alexandria Agent:** `demo.agent.alex@example.com` (`ALEXANDRIA`)
- **Citizen:** `demo.citizen@example.com` (National ID `29805150112319`)

## Production Deployment Guide

1. **Environment variables:** Configure all required variables in your platform secret store (see `.env.example`):
   - `NODE_ENV=production`, `PORT`, `DATABASE_URL` (TLS-enabled PostgreSQL 15+)
   - `JWT_SECRET` (at least 32 random bytes from a CSPRNG)
   - `CORS_ORIGINS` (exact HTTPS origins, comma-separated, never `*`) and `FRONTEND_BASE_URL`
   - `COOKIE_SAMESITE`: use `lax` when frontend and API share a registrable domain; use `none` (`Secure` is enabled automatically outside `development`/`test`) when deployed on separate registrable domains
   - `TRUST_PROXY`: set to the exact proxy hop count (e.g. `1`) behind Nginx / Cloudflare / load balancer so `req.ip` and rate limiting reflect real client IPs
   - `EMAIL_DRIVER=resend`, `EMAIL_PROVIDER_API_KEY`, `EMAIL_FROM`
   - `STORAGE_DRIVER` (`local` | `cloudinary` | `s3`): for Cloudinary set `STORAGE_DRIVER=cloudinary` with `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (or `CLOUDINARY_URL`) and optional `CLOUDINARY_FOLDER` (default `fast-id`); attachments are stored privately as `resource_type: 'raw'` + `type: 'authenticated'` and streamed only through the authenticated `GET /api/v1/applications/:id/attachments/:attachmentId/file` endpoint
   - `PAYMENT_MODE=disabled` until a real payment gateway replaces the MVP mock endpoint
   - Provide `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` only for first boot, change the password immediately after logging in, and remove `SEED_ADMIN_*` from the environment afterward.
2. **Reverse proxy & SSE:** Disable response buffering for `/api/v1/notifications/stream` (the API also sends `X-Accel-Buffering: no`) and keep read timeouts above the 25-second SSE ping interval.
3. **Migrations & startup:**
   ```bash
   npm ci --omit=dev
   npx prisma migrate deploy
   npm run start:prod
   ```
4. **Health & graceful shutdown:** Point liveness/readiness probes at `GET /api/v1/health` (`200 { status: "ok" }` or `503 SERVICE_UNAVAILABLE`). Send `SIGTERM` on rollout; `app.enableShutdownHooks()` drains HTTP requests, closes active SSE streams, stops scheduled jobs, and disconnects Prisma cleanly.
5. **Scaling note:** MVP runs as a single API instance (bounded in-memory rate limiters and SSE registry). Before scaling horizontally, back rate limiters and SSE pub/sub with Redis behind their existing interfaces.

## Backup & Restore Runbook

Verified end-to-end against PostgreSQL 15 (`pg_dump` -> `pg_restore` into a clean database with all tables, data, and append-only triggers intact).

### 1. Daily Logical Database Backup

```bash
pg_dump --format=custom --no-owner "$DATABASE_URL" > "fastid-$(date +%Y%m%d-%H%M).dump"
```

### 2. Sync Attachment Storage

```bash
# Local disk driver (sync outside web root to encrypted off-host backup target)
rsync -az --delete "$STORAGE_LOCAL_PATH/" /backups/fastid-storage/

# S3-compatible object storage driver
aws s3 sync "s3://$STORAGE_BUCKET" "s3://$BACKUP_STORAGE_BUCKET" --endpoint-url "$STORAGE_ENDPOINT"
```

### 3. Restore Database & Verify Integrity

```bash
# Restore into target database (replace $TARGET_DATABASE_URL carefully)
pg_restore --clean --if-exists --no-owner --dbname="$TARGET_DATABASE_URL" backup.dump

# Post-restore verification: confirm core row counts and immutability triggers
psql "$TARGET_DATABASE_URL" -c "
  SELECT
    (SELECT count(*) FROM services) AS services,
    (SELECT count(*) FROM service_versions) AS service_versions,
    (SELECT count(*) FROM users) AS users,
    (SELECT count(*) FROM applications) AS applications,
    (SELECT count(*) FROM settings) AS settings;
"
psql "$TARGET_DATABASE_URL" -c "
  SELECT tgname FROM pg_trigger
  WHERE tgname IN ('audit_append_only', 'ash_append_only', 'sv_immutable')
  ORDER BY tgname;
"
```

## Specifications

- `docs/Fast_ID_API_Contract.md` — API Contract v1.0.3-mvp (highest authority)
- `docs/Backend_System_Design.md` — Architecture & decisions v1.1
- `docs/Database_Design.md` — Database design v1.1
- `db/schema.sql` — PostgreSQL 15+ schema v1.1
