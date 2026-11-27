# shopify_app

<p align="center">
  <img src="https://img.icons8.com/?size=120&id=BRIdulMG66MK&format=png&color=000000" />
</p>
<p align="center">
<img src="https://img.icons8.com/?size=80&id=kg46nzoJrmTR&format=png&color=000000" alt="TypeScript"/>
<a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="80" alt="Nest" /></a>
<img src="https://img.icons8.com/?size=80&id=Pv4IGT0TSpt8&format=png&color=000000" alt="ExpressJS"/>
<img src="https://img.icons8.com/?size=80&id=KRA1PoZgRrca&format=png&color=000000" alt="PostgreSQL"/>
<img src="https://img.icons8.com/?size=80&id=lhwQTv6iwznY&format=png&color=000000" alt="GraphQL"/>
</p>

## Description

A Shopify stores management app.

**Stack:** NestJS 12.4 · TypeORM 1.1 · PostgreSQL · GraphQL Admin API `2026-10` · BullMQ 6 · Redis · EJS server-rendered views · Vitest

## Requirements

- **Node.js >= 20.19** (22.12+ or 24.x recommended; the framework packages are ESM-only and loaded through `require(esm)`)
- Docker

## Project setup

```bash
$ npm install

# generate the GraphQL types (Shopify Admin API 2026-10)
$ npm run graphql:types

# build
$ npm run build
$ docker compose up

# tests (unit + e2e; e2e needs PostgreSQL + Redis running)
$ npm test
$ npm run test:e2e
```

> `npm install` uses `legacy-peer-deps` (see `.npmrc`): TypeORM 1.1 declares an
> optional peer on `ioredis@^5` for its (unused here) Redis cache feature, which
> conflicts with the ioredis 6 this app uses.

### Environment file config

Copy `env_format.env` to `.env.development` (development) / `.env` (production) and fill in the values:

```ini
PORT=3000
APP_SECRET=<random string>

# Shopify app credentials + Admin API version
API_VERSION=2026-10
API_SECRET=<shopify app client secret>
API_KEY=<shopify app client ID>

APP_URL=<public url of the app>

CSRF_SECRET=<random string>

JWT_SECRET=<random string>
JWT_TOKEN_AUDIENCE=<app url>
JWT_TOKEN_ISSUER=localhost:3000
JWT_ACCESS_TOKEN_TTL=3600

DB_TYPE=postgres
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=<user>
DB_PASSWORD=<password>
DB_NAME=shopify_app
DB_SYNC=false            # schema sync (dev only)
DB_AUTOLOAD=true
DB_RUN_MIGRATIONS=true   # run migrations on boot

REDIS_HOST=localhost
REDIS_PORT=6379

# appSubscriptionCreate test charges (dev stores only)
BILLING_TEST_MODE=true
```

### GraphQL types

`src/generated/graphql.ts` is generated from the curated Admin API SDL in
`src/queries/schema/admin-2026-10.graphql` (see its header for why the schema
is vendored and how to swap in a store-endpoint introspection instead).

```bash
$ npm run graphql:types
```

### Database migrations & seeds

```bash
$ npm run migration:generate   # after changing entities
$ npm run migration:run
$ npm run migration:revert
$ npm run seed                 # seed plans
```

## Run

```bash
# development
$ npm run start:dev

$ docker compose up
# production
$ npm run build
$ npm run start:prod
```
