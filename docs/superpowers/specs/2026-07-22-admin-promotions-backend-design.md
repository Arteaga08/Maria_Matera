# Admin Promotions/Email Backend — Design Spec

**Date:** 2026-07-22
**Block:** 2 (admin dashboard) — fifth subsystem
**Status:** Approved by user (brainstorming 2026-07-22)

## Context

The coupon CRUD (create/edit/delete with full Joi validation) and the email broadcast already exist (M9). What is missing is the **read/performance layer**: the current admin list is unpaginated, there is no way to see what each coupon generated, and no subscriber count exists for the panel.

## Design (user-approved)

### 1. Improved list — `GET /admin/coupons` (rework of the unpaginated `adminList`)

- Pagination via `parseListQuery`/`buildMeta`; default sort `-createdAt` (allowed: `createdAt`, `validTo`, `usedCount`).
- Filters: `isActive`, `isVipOnly`, computed `status` (`vigente` | `expirado` | `agotado` — expired by `validTo`, exhausted by `usedCount >= maxRedemptions`).
- Search by code (escaped regex).
- Response shape moves to `{items} + meta` (same migration the Orders list went through).

### 2. Performance — `GET /admin/coupons/:id/performance` (new)

- `redemptions`: total + per-day series (optional `from`/`to`).
- `orders` (realized statuses only): count, `revenueCents` (sum of totalCents), `discountCents` granted.
- Reading: "this coupon cost $X in discounts and generated $Y in sales".
- 404 for a non-existent coupon.

### 3. Marketing stats — `GET /admin/marketing/stats` (new)

- Subscribers: total confirmed + `newInRange` (`from`/`to`, invalid range → 400).

### Untouched

- Coupon CRUD, `redeem`, `validateForPreview`, broadcast + its rate limiter.

## Files

- `apps/api/src/services/coupon.service.ts` — paginated `adminList(query)`, new `adminPerformance(id, query)`.
- Subscriber/newsletter service — new `adminStats(query)`.
- `apps/api/src/controllers/coupon.controller.ts` + marketing controller — wiring.
- `apps/api/src/routes/coupon.routes.ts` — `GET /:id/performance`; `apps/api/src/routes/subscriber.routes.ts` — `GET /stats`.
- Test: `apps/api/test/integration/coupon.admin-panel.test.ts` (TDD); adjust the existing `{coupons}` shape assertion if present.

## Verification

- Full suite green (331 existing + new); build clean.
- Smoke: list with `status=expirado`; performance figures correct against seeded orders; marketing stats range validation.
