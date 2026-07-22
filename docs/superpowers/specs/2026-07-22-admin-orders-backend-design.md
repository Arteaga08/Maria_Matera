# Admin Orders Backend — Design Spec

**Date:** 2026-07-22
**Block:** 2 (admin dashboard) — first subsystem
**Status:** Approved by user (brainstorming 2026-07-22)

## Context

Block 2 (admin dashboard) starts with the **Orders** subsystem. The dashboard must be a real operations panel — KPIs, complete data, control — not minimal list CRUDs. One subsystem at a time; the Home/Overview page will be built **last**, reusing this subsystem's stats endpoints (anti-duplication rule: aggregations live only here).

Current state of `/api/v1/admin/orders`:

- `adminList` exists but is **unpaginated** (`order.service.ts` fetches the whole collection).
- `adminGet` returns the raw document with no related data.
- Actions (advance/cancel/refund via `PATCH :id/status` and `POST :id/refund`) already exist and are **not touched**.
- The audit log has been written since M1 but never read (Step 5 gap this design closes for orders).

## Decisions (user-confirmed)

1. **Orders first**, Home/Overview last (it will consume these same endpoints).
2. **360° detail**: one call returns order + customer + certificates + audit log + product images.
3. **Full stats here** with date range (day/week/month/custom calendar): revenue with comparison, top sellers, pending shipments, per-status counts.
4. **`paid → processing` stays MANUAL** (control: "paid" = nobody has seen it; "processing" = being prepared). Existing automatic flow unchanged: webhook marks `paid`; `assignGuide` marks `shipped` when the tracking number is set; `markDelivered` is manual.
5. **Phone**: only the checkout snapshot (`shippingAddress.phone`/`recipientName`) is shown in the 360° detail. NO phone field is added to the Customer profile (that belongs to the future CRM subsystem).
6. Customer identity: already solved (`_id` + unique email) — no changes.

## Design

### 1. List — `GET /api/v1/admin/orders` (improve existing)

- Pagination/sort via `parseListQuery`/`buildMeta` (`apps/api/src/utils/listQuery.ts`), same pattern/response shape as `product.service.ts#adminList`.
- Filters: `status`, `paymentProvider`, date range (`from`/`to`), with/without coupon.
- Search: by `orderNumber` and by customer email/name (Customer lookup).
- Row shape: orderNumber, createdAt, customer (name/email), totalCents, status, payment.provider, has-tracking (bool).
- New index: `{ status: 1, createdAt: -1 }` (backs filtered list and stats).

### 2. 360° detail — `GET /api/v1/admin/orders/:id` (enrich existing)

One call returns:

- Full order (items enriched with product image via Product/Cloudinary lookup, amounts, addresses — including snapshot `phone`/`recipientName` —, payment, statusHistory).
- Customer: name, email, tier, previous purchase count, historical total spent.
- Certificates issued for the order (serial, date, download link) — first read/listing of certificates per order.
- `AuditLog` entries for the order (first audit-log read endpoint, order-scoped).
- Edge case: order without certificates / audit entries → empty arrays, never an error.

### 3. Stats — `GET /api/v1/admin/orders/stats` (new)

Query params `from`/`to` (Joi, ISO dates; today/7d/30d presets are sent by the frontend). Returns:

- Range revenue + comparison vs the equivalent previous range (▲/▼).
- Per-status counts, including operational alerts: *paid unattended* (`paid`) and *processing without tracking* (`processing` with no trackingNumber).
- Top products in range (by units and by revenue, from item snapshots).
- Average ticket and payment-provider breakdown (Stripe vs MP).
- Business rules: `cancelled` excluded; `refunded` subtracts.
- Implementation: on-the-fly MongoDB aggregation (`$match` + `$facet` with `$group`/`$unwind`), no precomputation, no new infra.

### 4. Security & validation

- Existing chain: `protect` + `restrictTo(Admin, Editor)` (`admin.order.routes.ts`).
- Joi `stripUnknown` for every new query param (pagination, dates, filters, search).
- No new rate limiter (admin read endpoints; mutation endpoints already have theirs).

## Files to touch (apps/api)

- `src/services/order.service.ts` — rewrite `adminList` (pagination/filters/search), enrich `adminGet` → 360° detail, new `adminStats`.
- `src/controllers/order.controller.ts` — wire stats + query params.
- `src/routes/admin.order.routes.ts` — `GET /stats` (registered before `/:orderId` to avoid route collision).
- `src/validators/order.validators.ts` — Joi schemas for list query and stats query.
- `src/models/Order.ts` — index `{ status: 1, createdAt: -1 }`.
- Tests (TDD): `order.service.test.ts` / `order.routes.test.ts` — list (pagination/filters/search), 360° detail (incl. order without certificates), stats (ranges, comparison, cancelled exclusion, refund subtraction).

**M9 note:** any test touching `markPaid`/`applyTransition` must mock `services/notification/order.notifications.js` (post-payment dispatcher runs in background).

## Verification

- Full API test suite green (165+ today; new tests added).
- Manual check with curl/Postman against dev: paginated list with combined filters, 360° detail of an order with and without certificates, stats with custom `from`/`to` and correct comparison.
