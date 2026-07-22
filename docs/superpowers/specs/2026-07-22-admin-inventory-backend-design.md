# Admin Inventory Backend — Design Spec

**Date:** 2026-07-22
**Block:** 2 (admin dashboard) — second subsystem (after Orders)
**Status:** Approved by user (brainstorming 2026-07-22)

## Context

The inventory models are rich (`ProductVariant` with `onHand`/`reserved`/virtual `available`, `StockReservation`) but no operational stock view exists — the admin cannot see inventory state. Low-stock alerts fire via Telegram but there is no panel.

## Decisions (user-confirmed)

1. **New endpoints** under `/api/v1/admin/inventory` (not an extension of `/admin/products`).
2. **No monetary valuation** for now — quantities and alerts only.
3. **Low-stock threshold = 5**, the same `LOW_STOCK_THRESHOLD` already used by the Telegram alert in `inventory.service.ts` (currently a private const → exported so the rule lives once).

## Design

### 1. Operational list — `GET /api/v1/admin/inventory` (new)

Per **variant** (the real unit of stock), paginated via `parseListQuery`/`buildMeta`:

- Row: SKU, product (name + `images.cardPrimary` via `$lookup`), size/material, onHand, reserved, available, `lowStock` flag (`available ≤ 5`).
- Filters: `lowStock=true`, `outOfStock=true` (available = 0), `category` (slug), `search` (SKU/product name), `includeArchived=true` (archived excluded by default).
- Allowed sort: `available` (asc = critical first), `sku`, `onHand`. Default: `available` asc.
- Implementation: aggregation (`$match` → `$lookup` to products → `$addFields available` → `$sort/$skip/$limit`), count in parallel.

### 2. Stats — `GET /api/v1/admin/inventory/stats` (new)

- Totals: active variants, total onHand units, total reserved units.
- Alerts: count + SKU list of low-stock and out-of-stock variants.
- Active reservations: count of `Active` reservations and units held (from `StockReservation`).

### 3. Untouched

- `adjustStock` (`PATCH /admin/variants/:id/stock`) — already audited + alerting; the panel consumes it as-is.
- Reservation machinery (reserve/commit/release/restock/releaseExpired).

## Files

- `apps/api/src/services/inventory.service.ts` — export `LOW_STOCK_THRESHOLD`; new `adminList(query)` and `adminStats()`.
- `apps/api/src/controllers/inventory.controller.ts` — new `adminList`, `adminStats`.
- `apps/api/src/routes/admin.inventory.routes.ts` — **new file**, `protect + restrictTo(Admin, Editor)`, `GET /` and `GET /stats`.
- App router mount for `/api/v1/admin/inventory`.
- TDD tests: `test/integration/inventory.admin.test.ts` (new) — service (filters, available, threshold, archived) + HTTP (401/403, shapes, pagination).

## Verification

- Full API suite green (304 existing + new).
- `pnpm --filter @maria-matera/api build` clean.
- Manual smoke: list with `lowStock=true`, stats counts coherent against seeded data.
