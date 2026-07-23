# Admin Audit Log Backend — Design Spec

**Date:** 2026-07-23
**Block:** 2 (admin dashboard) — sixth subsystem
**Status:** Approved by user (brainstorming 2026-07-23)

## Context

The append-only `AuditLog` has been written since M1 by every admin mutation (orders, inventory, CRM, coupons, certificates, marketing) and is already read per-order in the 360° order detail — but no global "who did what across the system" view exists.

## Decision (user-confirmed)

- **Admin role only** may read the global audit log (Editor → 403): it exposes every admin's actions and IPs — an ownership/supervision tool, same criterion as the VIP-tier change.

## Design

### `GET /api/v1/admin/audit` — the only new endpoint

- Pagination via `parseListQuery`/`buildMeta`; default sort `-createdAt`.
- Row: id, createdAt, actor (actorId + AdminUser username/email resolved via one `$in` fetch), actorType, action, module, targetId, before, after, ip.
- Filters: `module`, `action`, `actorId`, `targetId`, `from`/`to`.
- Read-only — the trail is append-only by design; no mutation endpoints ever.
- Index `{ createdAt: -1 }` added to back the global newest-first sort.

## Files

- `apps/api/src/services/audit.service.ts` — new `adminList(query)` alongside `recordAudit`.
- `apps/api/src/controllers/audit.controller.ts` — new.
- `apps/api/src/routes/admin.audit.routes.ts` — new; `protect + restrictTo(AdminRole.Admin)`.
- `apps/api/src/routes/index.ts` — mount `/admin/audit`.
- `apps/api/src/models/AuditLog.ts` — `{ createdAt: -1 }` index.
- Test: `apps/api/test/integration/audit.admin.test.ts` (TDD): pagination/desc order, filters, actor resolution, 401 anonymous / 403 Editor / 200 Admin.

## Verification

- Full suite green (341 existing + new); build clean.
- Smoke: audited actions (adjustStock/changeTier) appear filtered by module/actor; Editor gets 403.
