# Fast ID System — Backend API (`Fast-ID-api`)

REST API for the Fast ID System built with **NestJS 10**, **PostgreSQL 15+**, and **Prisma 6** (database-first).

## Prerequisites

- Node.js `>= 20` LTS
- Docker & Docker Compose (for PostgreSQL 15+)

## Quick Start (Clean Checkout)

```bash
# 1. Start PostgreSQL 15
docker compose up -d

# 2. Configure environment variables
cp .env.example .env
# Edit .env and set local values (DATABASE_URL, JWT_SECRET, CORS_ORIGINS, FRONTEND_BASE_URL, etc.)

# 3. Install dependencies
npm ci

# 4. Apply SQL migrations (database-first; never run `prisma migrate dev`)
npm run migrate

# 5. Start the API in watch mode
npm run start:dev
```

## Database Migration Rules

- `prisma/migrations/0001_init/migration.sql` is `db/schema.sql` copied verbatim.
- Future schema changes must be authored manually as timestamped SQL files under `prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql`.
- Apply migrations with `npm run migrate` (`prisma migrate deploy`), then regenerate Prisma models with `npm run db:pull` (`prisma db pull && prisma generate`).
- Note for Prisma 6 `db pull`: PostgreSQL's deferred composite FK `services_published_version_fk` (`(id, published_version) -> service_versions(service_id, version)`) is introspected as a one-to-one relation without `@@unique([id, published_version])`. Keep the back-relation on `service_versions` (`services_services_id_published_versionToservice_versions`) as `services[]` in `prisma/schema.prisma` before running `prisma generate`.
- **Never** run `prisma migrate dev` and **never** edit an already-applied migration.

## Verification Commands

```bash
npm run lint
npm run build
npm test
npm run test:e2e
```

## Specifications

- `docs/Fast_ID_API_Contract.md` — API Contract v1.0.3-mvp (highest authority)
- `docs/Backend_System_Design.md` — Architecture & decisions v1.1
- `docs/Database_Design.md` — Database design v1.1
- `db/schema.sql` — PostgreSQL 15+ schema v1.1
