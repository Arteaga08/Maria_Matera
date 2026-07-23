# Admin Certificates Backend — Design Spec

**Date:** 2026-07-22
**Block:** 2 (admin dashboard) — fourth subsystem (after Orders, Inventory, CRM)
**Status:** Approved by user (brainstorming 2026-07-22)

## Context

Certificate issuance (post-payment, M8/M9), the audited admin reissue and the customer download already exist. The only gap is an **admin list/search** — today an admin cannot browse issued certificates at all.

> **Client-pending note:** the certificate PDF's visual design will be delivered by the client (Maria). When it arrives, only the template in `apps/api/src/services/pdf/certificate.pdf.ts` changes — issuance/serial/storage logic stays untouched. Out of scope here.

## Design (user-approved)

### `GET /api/v1/admin/certificates` — the only new endpoint

- Pagination via `parseListQuery`/`buildMeta`; default sort `-issuedAt` (allowed: `issuedAt`, `serialNumber`).
- Row: id, serialNumber, item (sku/name from `orderItemSnapshot`), orderId + orderNumber (Order lookup), customer (name/email, Customer lookup), issuedAt, pdfUrl.
- Filters: `from`/`to` over `issuedAt`.
- Search (escaped regex): serialNumber, item SKU/name directly; order number and customer name/email via id-lookup (same `buildCustomerSearchIds` approach as the Orders list).

### Untouched

- `adminReissue`, customer routes, `issueForOrder`.

## Files

- `apps/api/src/services/certificate.service.ts` — new `adminList(query)`.
- `apps/api/src/controllers/certificate.controller.ts` — new `adminList`.
- `apps/api/src/routes/certificate.routes.ts` — `adminRouter.get("/", ctrl.adminList)`.
- Test: `apps/api/test/integration/certificate.admin-list.test.ts` (TDD).

## Verification

- Full suite green (326 existing + new); build clean.
- Smoke: list searched by serial and by customer email; date filter coherent.
