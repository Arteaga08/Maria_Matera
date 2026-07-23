# Admin CRM Backend — Design Spec

**Date:** 2026-07-22
**Block:** 2 (admin dashboard) — third subsystem (after Orders, Inventory)
**Status:** Approved by user (brainstorming 2026-07-22)

## Context

The `Customer` model is rich (name, email, emailVerified, tier standard/VIP, addresses, wishlist, marketingConsent) but zero admin endpoints exist — the VIP tier can only be changed by hand-editing the database.

## Decisions (user-confirmed)

1. Reads (list/detail/stats) **plus a tier mutation** (promote/demote VIP), audited.
2. Tier change restricted to **Admin role only** (not Editor) — VIP affects exclusive coupons/products.
3. Historical spend uses the same "realized sale" rule as Orders (`REALIZED_SALE_STATUSES`: paid/processing/shipped/delivered; refunded excluded) — the constant is exported from `order.service.ts` and shared.

## Design

### 1. List — `GET /api/v1/admin/customers` (new)

- Pagination via `parseListQuery`/`buildMeta`.
- Row: name, email, emailVerified, tier, marketingConsent, createdAt, `ordersCount`, `totalSpentCents` (aggregation over realized orders).
- Filters: `tier`, `emailVerified`, `marketingConsent`, `from`/`to` (registration date). Search: escaped regex on name/email. Sort: `createdAt` (default desc), `totalSpentCents`, `ordersCount`.

### 2. Detail — `GET /api/v1/admin/customers/:id` (new)

- Full profile (never the password — `select: false` already covers it) + addresses + consent.
- `orders`: the customer's orders (orderNumber, createdAt, totalCents, status), newest first.
- Totals: totalSpentCents, averageTicketCents, ordersCount (realized rule).
- `wishlist`: products with name + `images.cardPrimary`.
- 404 for a non-existent customer.

### 3. Tier — `PATCH /api/v1/admin/customers/:id/tier` (new)

- Joi body `{ tier: CustomerTier }` (stripUnknown, Spanish messages).
- `restrictTo(AdminRole.Admin)` on this route only (reads are Admin+Editor).
- `recordAudit` with action `CHANGE_CUSTOMER_TIER`, module `crm`, before/after tier.

### 4. Stats — `GET /api/v1/admin/customers/stats` (new)

- Totals: customers, VIP count, verified count, marketing-consent count.
- `newInRange` with `from`/`to` (same contract/400 validation as Orders stats).
- `topCustomers`: top 10 by realized spend (id, name, email, tier, totalSpentCents, ordersCount).

## Files

- `apps/api/src/services/customer.admin.service.ts` — new focused module.
- `apps/api/src/controllers/customer.admin.controller.ts` — new.
- `apps/api/src/routes/admin.customer.routes.ts` — new; `/stats` registered before `/:id`.
- `apps/api/src/validators/customer.validators.ts` — `changeTierSchema`.
- `apps/api/src/routes/index.ts` — mount `/admin/customers`.
- `apps/api/src/services/order.service.ts` — export `REALIZED_SALE_STATUSES`.
- Test: `apps/api/test/integration/customer.admin.test.ts` — TDD: service (list filters/spend, detail wishlist/orders/404, tier audit, invalid stats range 400) + HTTP (401/403 by role — Editor reads but cannot change tier, shapes).

## Verification

- Full API suite green (314 existing + new); `pnpm --filter @maria-matera/api build` clean.
- Smoke: list with `tier=vip`, detail with wishlist, PATCH tier as Editor → 403, as Admin → 200 + audit entry.
