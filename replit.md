# Perfect Game Sales Tracker

## Overview
A full-stack dashboard that syncs and visualizes daily sales, revenue, and gift card activity from the Square Payments API.

## Architecture
- **Frontend**: React + TypeScript + TanStack Query + shadcn/ui (Vite dev server)
- **Backend**: Express.js + TypeScript
- **Square SDK**: `square` v44.0.1 (uses `SquareClient` / `SquareEnvironment` — no axios dependency)
- **Database**: PostgreSQL (Neon) via Drizzle ORM. `shared/schema.ts` is the single source of truth for types.
- **Timezone**: UTC stored in DB; Eastern Time boundaries applied at query time via `getEasternDateRange` in `server/dateUtils.ts`.

## Key Features
- Real-time sales dashboard with daily/weekly/monthly/custom date ranges
- Gift card sales & redemption tracking with activation amounts from Square's Gift Card Activities API
- Refund/return, CC processing fee, and Intercard arcade revenue tracking
- Items-by-category breakdown driven by Square's Catalog hierarchy
- Nightly automatic sync at 3 AM ET plus a 60-second incremental cycle (`node-cron`)
- Admin panel: user management + data sync controls
- MCP server exposing the sales DB to Claude

## Environment Variables
**Required:** `DATABASE_URL`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`. `SESSION_SECRET` is warned-on if missing.

**Secrets (in Replit Secrets, never in `.replit`):**
- `TOTP_ENCRYPTION_KEY` — 32-byte key (64-char hex or base64) used to AES-256-GCM encrypt users' 2FA secrets at rest. App throws at 2FA-use time if unset. Rotating it invalidates existing 2FA enrollments (re-encrypt or have users re-enroll).
- `GIT_SSH_PRIVATE_KEY` — see Operations → Git over SSH.

**Production:** `APP_BASE_URL` MUST be set in production (used to build password-reset links; never derived from the Host header in prod). Currently `https://pgdailydash.com`.

**Intercard:** `INTERCARD_HOST`, `INTERCARD_MAC_ID`, `INTERCARD_CORP_ID`.

**Email:** `MAIL_FROM_EMAIL` (default `info@myperfectgame.com`), `MAIL_FROM_NAME`.

**Test suite:** `TEST_DATABASE_URL` (optional override).

**Optional, intentionally unwired (opt-in no-ops — see Operations → Logging):** `LOG_SHIPPER_URL`/`LOG_SHIPPER_TOKEN`, `SERVER_ERROR_ALERT_WEBHOOK_URL`, `EMAIL_ALERT_WEBHOOK_URL`, `APP_SETTINGS_INVALID_ROW_ALERT_WEBHOOK_URL` (each has optional threshold/window/cooldown tunables).

## Data Sync
Two sync paths co-exist: **legacy** (`server/routes.ts` — `/api/simple-sync`, `/api/full-sync`) and **service-based** (`server/routes/api.ts` + `server/services/syncService.ts`). `syncService.ts` orchestrates syncs and manages the `sync_state` table.

**Sync types:** `payments`, `orders`, `giftCards_incremental`, `giftCards_historical`, `giftCardRedemptions`, `refunds`.

**Schedule** (`server/services/schedulerService.ts`):
- **Every 60s**: payments, orders, refunds (15-min window), gift card incremental, gift card redemptions, REDEEM balance monitor, Intercard today.
- **Nightly 3 AM ET**: deep sync (3-day lookback) for payments/orders/refunds, catalog sync + backfill, payout fee sync, full gift card balance refresh (zeros out deleted cards).
- **On startup**: historical backfill loops (gift cards, orders/payments, Intercard) run once in background if incomplete.

### Gift card sync
All gift card data flows through two methods (the old `listGiftCards`-based `syncGiftCards()` was removed — it had no date filter and lost pagination on restart):
- **Historical backfill** (`syncGiftCardsHistoricalBackfill`): one-time oldest-first scan of all ACTIVATE events via the Activities API. Resumable via saved cursor checkpoint; completed. 3-min stale-lock timeout.
- **Incremental** (`syncIncrementalGiftCards`): every 60s, fetches ACTIVATE events newer than the last watermark (2-min overlap), links each to its activation order. On Square 404 (deleted/fully-redeemed card) it creates a basic record from the ACTIVATE event so short-lived deposit cards are still tracked. 10-min stale-lock timeout.

### REDEEM balance monitor
Every 60s, fetches REDEEM events since the last watermark and refreshes only the affected cards' balances from Square (1-2 calls/cycle + 1/redeemed card) — keeps outstanding-value balances near-real-time instead of waiting for the nightly full refresh. Uses `sync_state` key `giftCard_redeem_monitor`.

### Stale lock safeguard
Any sync with a concurrency guard checks elapsed time since `lastSyncedAt` and force-resets if stuck `in_progress` past its timeout (a server crash mid-sync would otherwise block all future runs). A `console.warn` is emitted on reset for log visibility.

### Historical catch-up endpoints
- `POST /api/sync/historical` — background job chunking through monthly ranges (orders/payments/refunds) then a full gift card sync + activation backfill.
- `POST /api/sync/gift-cards-backfill` — resumable Activities-API backfill; call until `finished: true`.

## Business Logic & Classification

### Gift card sales & redemption classification
**Business context:** Web reservations are booked through **Qubica** (not Partywirks, which is separate birthday-booking software using $100 deposit increments). Booking online creates a Web Reservation order plus an electronic gift card activated for the deposit amount and linked to the order; staff redeems the card on arrival. Nearly all gift cards are deposit cards; true gift-card sales are rare.

**Source buckets:**

| Order Source | Dashboard Category |
|---|---|
| `Web Reservation` | Bowling Web Res Deposits |
| `Multi Attractions Reservation` | Laser Tag Web Res Deposits |
| `Web Reservation-Attraction` | Laser Tag Web Res Deposits |
| Everything else (NULL, `Terminal`, `unknown`, …) | True Gift Card Sales/Redemptions |

**Deposits side** (`giftCardService.ts → getGiftCardBreakdown`): queries `orders` by `source` (confirmed via a `Deposit` line-item filter), independent of `gift_cards` linkage. `giftCardSales` = total SQUARE_GIFT_CARD tenders minus bowling minus laser tag deposits.

**Redemption side** (`dashboardService.ts → getDetailedTransactionBreakdown`): total = sum of SQUARE_GIFT_CARD tenders from `orders.square_data`. Classification fetches REDEEM activities (which give the exact `giftCardId`), then resolves each back to its activation order's source via a 3-tier pipeline:
1. **DB link (primary)**: `gift_cards.activation_square_order_id → orders.source`. ~100% reliable for April-2025-onward cards.
2. **ACTIVATE API fallback**: query Square's ACTIVATE activity for the card's order ID (batch-retrieving missing orders), then check source.
3. **Heuristic closest-match (legacy only)**: for pre-April-2025 cards with no API data, match activation amount to the closest web-reservation `orders.total_money` by time proximity. Logs >24h-gap matches.

If API calls fail, the whole redemption total degrades gracefully to pure GC redemptions. Linkage health: pre-March 2025 ~100% missing (historical debt), March 2025 ~60%, April 2025+ ~0%.

Key functions: `squareClient.ts → fetchGiftCardRedeemActivities`, `fetchGiftCardActivateActivity`, `fetchOrdersByIds`.

### Refunds vs Returns (CRITICAL — separate objects in Square)
Square treats refunds and returns as distinct objects, queried separately and always tracked separately in the DB/backend even when the UI combines them.
- **Refunds**: refund records with NO `reason`. Straight money-back; full amount used.
- **Returns**: refund records WITH a `reason` (e.g. "Accidental Charge"). Item returns; amount used is pre-tax (refund total minus return tax from the order's `returnAmounts.taxMoney`). Taxes are reduced by that tax portion.
- `getDetailedTransactionBreakdown()` queries them separately (`reason IS NULL` vs `reason IS NOT NULL`). `getRevenueBreakdown()` in `paymentService.ts` uses ALL refunds combined for True Revenue.
- Data lives in the `refunds` table; fetched via `fetchRefunds()` (Square `RefundsApi.listPaymentRefunds()`).

### CC processing fees (payout fees)
Square's cost-plus model charges the full fee per transaction then reimburses overcharges via payout entries. `payout_fee_entries` stores CHARGE / FEE / THIRD_PARTY_FEE entries; `payoutService.ts` syncs them (initial from Jan 2025, incremental last 7 days, nightly + startup). `getProcessingFees()` returns initialFees/reimbursements/thirdPartyFees/netFees. Caveat: reimbursements lag 1-2 business days, so monthly totals are more accurate than daily.

### Intercard arcade revenue
`intercardService.ts` — JWT-authed client for the Intercard Revenue Extract REST API (token cached 50 min). Per-device daily rows in `intercard_revenue`. syncToday() runs every 60s + nightly; historical backfill (from Jan 1 2025) on startup. Included in the True Revenue KPI and shown as a StatsSummary line item. Uses ET formatting with DST-aware UTC offsets.

### Square catalog categories
Item categories come from Square's Catalog API, not name guessing. `catalogService.ts`: `syncCatalog()` fetches CATEGORY + ITEM objects, `backfillCategories()` re-categorizes existing records, `lookupCategorySync()` does in-memory lookups (cache preloaded before payment syncs, catalog synced at the start of each order cycle). Tables: `square_categories` (id→name, plus nullable `parent_category_id`: NULL = top-level rollup), `square_catalog_items` (object/variation → category, plus `is_archived`). `categorySchema` is `z.string()` so any Square category name is accepted. Moving items between categories in Square is picked up automatically. Endpoints: `POST /api/sync/catalog`, `POST /api/sync/catalog/backfill`.

## Dashboard

### Items by Category tab
Between Overview and Gift Cards (`BottomNavigation.tsx`). Renders one panel per top-level Square category rollup (any top-level category with ≥1 child becomes a panel — nothing is hardcoded to Food/Beverage). Each panel has its own category dropdown (`All <Rollup>` + direct children), metric toggle (Revenue/Units/Transactions), and a ranked list of items that sold in the window. Only items with non-zero revenue are listed (zero-revenue items are hidden); internal `(KDS)` items are excluded entirely. Zero-sales items will become available in the planned per-category BI drill-down.
- `itemsService.ts`: `getCategoryTree()` (full forest), `getRankedItems(categoryId, metric, dateRange)` (LEFT JOIN catalog items against windowed `order_line_items`, then merges true duplicates by **normalized name + category + price** — Square stores the online-menu and POS copies of each food item as two independent catalog objects with no shared SKU/UPC but identical name/category/price, so price is the discriminator that collapses real duplicates without merging a genuinely different item that merely shares a name; finally filters out `(KDS)` items and any row with `revenue === 0`; JS sort with name tiebreaker). Price comes from `square_catalog_items.price_amount` (cents, nullable), populated by `catalogService.syncCatalog()` from each variation's `priceMoney.amount`.
- `GET /api/items/categories`, `GET /api/items/ranked` (both 60/min, behind `requireAuth`; `ranked` requires `categoryId` and validates `metric`).
- Opening the tab auto-bumps the range to `last7days` once per session, but only if the user hasn't picked a range (`dateRangeUserChanged` / `itemsTabAutoSet` guards). Visible to all authenticated users.

## API Endpoints
- `GET /api/summary` — daily summary (revenue, gift card sales, order count)
- `GET /api/gift-card-summary` — gift card sold/redeemed totals for a range
- `GET /api/sync/status` — last sync timestamps per type
- `POST /api/sync/historical` — background full catch-up (orders/payments/refunds)
- `POST /api/sync/gift-cards-backfill` — resumable gift card backfill (call until `finished=true`)
- `POST /api/fix-gift-cards` — re-run activation amount backfill
- `GET /api/analyze-gift-cards` — gift card coverage statistics

## MCP Server (Claude integration)
`server/mcp.ts`, mounted on the main Express app. Endpoint `https://<domain>/mcp` (Streamable HTTP, same port), health at `/mcp/health`. Uses `@modelcontextprotocol/sdk` (`StreamableHTTPServerTransport`). `registerMcpRoutes(app)` is called before session middleware; each session gets its own server + transport, tracked by UUID with 30-min idle TTL, max 50 concurrent.

All tools share date-range params: `dateRange` (today/yesterday/last7days/last30days/thisMonth/lastMonth/custom) + optional `startDate`/`endDate`. 22 tools total:
- **Summaries/breakdowns**: `get_daily_summary`, `get_detailed_breakdown`, `get_gift_card_summary`, `get_gift_card_breakdown`, `get_processing_fees`, `get_refunds_list`, `get_intercard_revenue`
- **Revenue analysis**: `get_hourly_revenue`, `get_category_revenue`, `get_top_selling_items`, `get_daily_revenue_trend`, `compare_periods`
- **SQL-only (query Postgres directly, fast for any range)**: `get_monthly_revenue_trend`, `get_revenue_by_day_of_week`, `get_revenue_by_source`, `get_monthly_order_stats`, `get_hourly_heatmap`, `get_top_items_by_month`, `run_read_query` (arbitrary read-only SQL — READ ONLY transaction + keyword blocklist)
- **Ops/meta**: `get_sync_status`, `get_database_stats`, `query_orders`

## Auth & Security
- **Password strength**: new passwords (registration, admin-create, reset) must be 12-128 chars with ≥1 letter and ≥1 digit (`strongPasswordSchema`). Login allows shorter legacy passwords so existing accounts can sign in and rotate.
- **Per-account lockout**: 5 consecutive failed attempts on a username → 15-min lock (`failed_login_count`, `locked_until`), regardless of IP, to defeat IP-rotating credential stuffing. Atomic increment + check; success resets. Lockout is unobservable — same 401 body as a wrong password, always exactly one `bcrypt.compare` (real or dummy hash) so unknown-user / locked / wrong-password are indistinguishable by status, body, and timing.
- **Session fixation**: login regenerates the session ID before attaching auth state.
- **Password reset (email-verified, enumeration-safe)**: `POST /api/auth/request-reset` always returns the same generic 200 and does the lookup/token/email work async (`setImmediate`) so latency can't be an oracle. Single-use 256-bit token, SHA-256 hashed, 30-min expiry; issuing a new link invalidates prior ones; 3/IP/hour. `POST /api/auth/complete-reset` redeems `{token, newPassword}` in one transaction (can't be reused) and clears any lockout. Link base URL is `APP_BASE_URL` in prod (never Host-header derived).
- **Email delivery**: `emailService.ts` uses the Replit Gmail integration — fetches a short-lived OAuth token per send and POSTs to the Gmail REST API. From defaults to `info@myperfectgame.com` (the OAuth Workspace account owns/has a verified send-as alias). Prod throws if the connector isn't wired (no silent drops); dev with no connector writes the message to a file under `os.tmpdir()/pg-dev-emails`. Structured `emailService.send_failed`/`send_succeeded` logs carry a stable `reason`, HTTP `status`, a `recipientHash` (no literal address on disk), and the Gmail message ID for correlation.
- **API hardening**: rate limits (all `/api` 100/min; login 10/15min; sync 5/min — `server/middleware/rateLimiter.ts`); all data routes require an authenticated session except `/api/health` and `/api/sync/status`; all sync/backfill POSTs require admin role. React `ErrorBoundary` wraps the app. Startup env validation (`server/validateEnv.ts`). DB indexes created at startup. Sessions: httpOnly, 30-day, sameSite lax, Postgres-backed store. Health: `GET /api/health`.

## Operations

### Admin bootstrap (first admin)
There is no public registration. `POST /api/auth/register` is admin-only. To create the first admin on a fresh DB, run the bootstrap script out-of-band:
```bash
INITIAL_ADMIN_USERNAME=alice INITIAL_ADMIN_PASSWORD='strong-password' tsx scripts/bootstrap-admin.ts
# or: tsx scripts/bootstrap-admin.ts <username> <password>
```
It wraps check-and-insert in a transaction guarded by a Postgres advisory lock (`pg_advisory_xact_lock`) so at most one admin is ever created; it refuses if an admin already exists. Create further users via the admin UI. `role` can only be set through `adminCreateUserSchema` (server-validated; body values otherwise coerced to `'user'`).

### Git over SSH (persistent across container rebuilds)
`origin` is SSH (`git@github.com:PerfectGameFTW/Perfect-Game-Daily-Dash.git`). `~/.ssh/` is wiped on every container rebuild, so the key lives in the `GIT_SSH_PRIVATE_KEY` Secret (same key as the LeagueVault workspace). `scripts/setup-git-ssh.sh` materializes it into `~/.ssh/id_ed25519` (mode 600), normalizes PEM line-wrap, and pins GitHub host keys; `.config/bashrc` (workspace-tracked) runs it on every interactive shell start, so auth re-establishes automatically. To set up a new workspace or rotate: add/replace the Secret, run `bash scripts/setup-git-ssh.sh`, verify with `ssh -T git@github.com`.

### Running the test suite
The vitest suite (`server/tests/`) writes real tables and grants real Postgres roles, so it runs against a **separate test DB, never the live `DATABASE_URL`**:
- `setup.ts` resolves the test URL from `TEST_DATABASE_URL`, else derives it by appending `_test` to the DB name (`…/neondb` → `…/neondb_test`), then rewrites `process.env.DATABASE_URL`. It throws if no test URL resolves or it equals the live one.
- `globalSetup.ts` runs once per `vitest run`: acquires a session-scoped advisory lock on the test DB (held for the whole run) and `TRUNCATE`s every public table. Concurrent runs **serialize** on this lock (they do not get isolated ephemeral DBs); the lock session heartbeats every 30s and waits are bounded at 15 min via `lock_timeout`.
- `scripts/ensure-test-db.ts` provisions the sibling DB idempotently. `scripts/post-merge.sh` runs the helper, pushes schema to the test DB, then runs `vitest run`.
```bash
TEST_DATABASE_URL=$(npx tsx scripts/ensure-test-db.ts); export TEST_DATABASE_URL
DATABASE_URL=$TEST_DATABASE_URL npm run db:push -- --force
npx vitest run
```

### Logging & observability
Structured logger (`server/logger.ts`) emits one JSON line per event to stdout/stderr. **The Replit workspace log pane is the single source of truth** — by deliberate owner decision, no logs or alerts are shipped to any third party. Log shipping (`logShipper.ts`), 5xx alerting (`serverErrorAlert.ts`), email-failure alerting (`emailAlert.ts`), and `app_settings` invalid-row alerting (`appSettingsInvalidRowAlert.ts`) all exist but are **opt-in no-ops** — they short-circuit when their env vars are unset and add zero overhead. Enabling any is a pure config change (set the env var(s) from the Environment Variables section, redeploy). The Admin → Alerts tab has an **App settings registry** card (`GET /api/admin/app-settings/validation`, admin-only, read-only) showing each registry key's validation status.

**Runbook — `app_settings invalid row` alert:** never hand-edit the row in psql. Either ship a migration that rewrites it to the new shape, or one that deletes it so the consumer's hard-coded default takes over. Hand edits leave no audit trail and recreate the drift the alerter exists to catch.

## Important Files
- `server/squareClient.ts` — Square API client, all fetch functions
- `server/services/syncService.ts` — sync orchestration, `sync_state` management
- `server/services/schedulerService.ts` — cron scheduler
- `server/services/giftCardService.ts` — gift card queries / deposit breakdown
- `server/services/enhancedGiftCardFix.ts` — activation amount backfill
- `server/services/payoutService.ts` — CC processing fee sync
- `server/services/intercardService.ts` — Intercard revenue client/sync
- `server/services/catalogService.ts` — Square Catalog sync, category cache, backfill
- `server/services/itemsService.ts` — Items-by-category tree + ranked items
- `server/services/dashboardService.ts` — detailed breakdown / redemption classification
- `server/services/paymentService.ts` — revenue breakdown / True Revenue
- `server/services/emailService.ts` — Gmail-integration email sending
- `server/dateUtils.ts` — Eastern Time boundary calculations
- `server/mcp.ts` — MCP routes/tools
- `server/middleware/rateLimiter.ts` — API/auth/sync rate limiters
- `server/validateEnv.ts` — startup env validation
- `shared/schema.ts` — Drizzle ORM schema (single source of truth)
- `client/src/pages/Admin.tsx` — admin panel
- `client/src/components/dashboard/Header.tsx` — last-synced indicator
- `client/src/components/ErrorBoundary.tsx` — React error boundary

## Agent Workflow Preferences

### Follow-up task proposals
Only propose follow-up tasks that are **critical or high priority** — a direct security risk, data-integrity issue, or broken/missing feature that meaningfully impacts daily use. Do not propose medium/low/nice-to-have items (housekeeping, refactoring, test-coverage improvements, incremental enhancements) unless they carry genuine production risk.

### Pre-existing errors
Always fix pre-existing errors (failing tests, type errors, broken builds, runtime crashes) before marking a task complete. If a task exposes an error already present in the codebase, resolve it as part of the task rather than deferring it.
