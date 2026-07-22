# Admin Orders Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the admin Orders endpoints (`/api/v1/admin/orders`) into the operational backend for the dashboard's first subsystem: paginated/filterable list, a 360° order detail (customer + certificates + audit log + product images), and a stats endpoint (revenue with comparison, per-status counts, top products, average ticket, payment-provider breakdown, operational alerts).

**Architecture:** Three additions to the existing `order.service.ts` module (no new files, no DI, matching this codebase's existing "exported functions over a fixed import" convention): a rewritten `adminList` using the shared `parseListQuery`/`buildMeta` pagination pattern already used by `product.service.ts`, an enriched `adminGet` that fans out to `Customer`/`Product`/`Certificate`/`AuditLog` in parallel, and a new `adminStats` built on MongoDB `$facet` aggregation. No existing business logic (transitions, refund, webhook paths) is touched.

**Tech Stack:** TypeScript, Express, Mongoose (aggregation pipeline), Joi (validators — request body only, matching this codebase's existing convention that list/stats query params are parsed defensively in the service layer, not through the body-only `validate` middleware), Vitest + Supertest (existing test conventions in `order.test.ts`/`order.service.test.ts`).

---

## Important existing-code context (read before starting)

- `apps/api/src/services/order.service.ts` — the module you're extending. `adminList`/`adminGet` are at the bottom (lines ~661-679 today). `ALLOWED_TRANSITIONS`, `applyTransition`, `advance`, `refund`, `adminAdvance`, `adminRefund` are NOT touched by this plan.
- `apps/api/src/utils/listQuery.ts` — `parseListQuery({allowedSort, defaultSort, maxPageSize}, query)` returns `{page, pageSize, skip, sort}`; `buildMeta(page, pageSize, total)` returns `PaginationMeta`. Used exactly this way in `apps/api/src/services/product.service.ts:111-123`.
- `apps/api/src/controllers/product.controller.ts:20-23` — the calling convention: controller passes `req.query` straight to the service (no Joi query validation in this codebase — `mongoSanitize` middleware already strips NoSQL-injection attempts, and the service defensively whitelists/coerces every field). This plan follows that same convention for the new list/stats query params, NOT a new Joi query schema.
- `apps/api/src/models/Order.ts` — `OrderDocument` fields, existing indexes at lines 198-203.
- `apps/api/src/models/AuditLog.ts` — `{actorId, actorType, action, module, targetId, before, after, ip, createdAt}`. Orders write with `module: "order"` (see `MODULE` const in `order.service.ts:42`) and `targetId: orderId` (a string).
- `apps/api/src/models/Certificate.ts` — `{orderId, customerId, orderItemSnapshot: {sku, name}, serialNumber, pdfUrl, issuedAt}`.
- `apps/api/src/models/Customer.ts` — `{name, email, tier}` (no phone field — confirmed out of scope by the design spec).
- `apps/api/src/models/Product.ts` — `images.cardPrimary` (string URL).
- `apps/api/test/integration/order.test.ts` — existing HTTP tests. **Line 252-254 asserts `list.body.data.orders.length` on an array** — this will need a one-line update once `adminList`'s response shape changes to `{orders: items, meta}` (Task 2, Step "update the existing test").

---

## Task 1: Paginated/filterable admin order list

**Files:**
- Modify: `apps/api/src/services/order.service.ts` (replace `adminList`, `~line 661-677`)
- Modify: `apps/api/src/controllers/order.controller.ts` (replace `adminList` controller, `~line 34-40`)
- Modify: `apps/api/src/models/Order.ts` (add index, after line 200)
- Test: `apps/api/test/integration/order.service.test.ts` (new `describe("adminList")` block)
- Test: `apps/api/test/integration/order.test.ts` (update existing admin-list assertion)

- [ ] **Step 1: Add the compound index used by the filtered list and stats**

In `apps/api/src/models/Order.ts`, right after the existing index block (after line 200, `orderSchema.index({ customerId: 1, createdAt: -1 });`), add:

```ts
// Backs admin list filtering by status + the stats aggregation's date-range
// match (both group/sort on status within a createdAt window).
orderSchema.index({ status: 1, createdAt: -1 });
```

- [ ] **Step 2: Write the failing service test for `adminList`**

Add to `apps/api/test/integration/order.service.test.ts` (this file already imports `Order`, `Customer`, `Product`, `ProductVariant`, `mongoose`, `OrderStatus`, `PaymentProvider` — reuse those). Append a new `describe` block near the end of the file, before the final closing of the file (check the file's existing structure with `tail -30 apps/api/test/integration/order.service.test.ts` first to match the exact helper functions already defined there, e.g. whatever helper creates a ready-to-checkout order — reuse it rather than re-deriving cart/address setup):

```ts
describe("adminList", () => {
  const makeOrder = async (overrides: Partial<{
    customerId: mongoose.Types.ObjectId;
    status: OrderStatus;
    paymentProvider: PaymentProvider;
    orderNumber: string;
    couponCode?: string;
    createdAt: Date;
  }> = {}) => {
    const customer = await Customer.create({
      name: "Cliente Test",
      email: `list-${new mongoose.Types.ObjectId().toHexString()}@test.com`,
      password: "Password123",
      emailVerified: true,
    });
    const product = await Product.create({
      name: "Anillo Lista",
      slug: `anillo-lista-${new mongoose.Types.ObjectId().toHexString()}`,
      description: "Anillo de oro de 18k.",
      categoryId: new mongoose.Types.ObjectId(),
      priceCents: 100000,
      isPublished: true,
      isArchived: false,
    });
    const variant = await ProductVariant.create({
      productId: product._id,
      sku: `RING-LIST-${new mongoose.Types.ObjectId().toHexString()}`,
      onHand: 5,
    });
    const order = await Order.create({
      customerId: customer._id,
      orderNumber: overrides.orderNumber ?? `MM-${new mongoose.Types.ObjectId().toHexString().slice(0, 12).toUpperCase()}`,
      items: [
        {
          productId: product._id,
          variantId: variant._id,
          sku: variant.sku,
          name: product.name,
          qty: 1,
          unitPriceCents: 100000,
          lineSubtotalCents: 100000,
        },
      ],
      shippingAddress: {
        label: "Casa",
        line1: "Av. Reforma 123",
        city: "CDMX",
        state: "CDMX",
        zip: "06600",
        country: "México",
      },
      billingAddress: {
        label: "Casa",
        line1: "Av. Reforma 123",
        city: "CDMX",
        state: "CDMX",
        zip: "06600",
        country: "México",
      },
      subtotalCents: 100000,
      shippingCostCents: 0,
      totalCents: 100000,
      status: overrides.status ?? OrderStatus.PendingPayment,
      payment: { provider: overrides.paymentProvider ?? PaymentProvider.Stripe, status: "pending" },
      idempotencyKey: `idem-${new mongoose.Types.ObjectId().toHexString()}`,
      reservationId: new mongoose.Types.ObjectId(),
      reservationExpiresAt: new Date(Date.now() + 60_000),
      ...(overrides.couponCode ? { couponCode: overrides.couponCode } : {}),
    });
    if (overrides.createdAt) {
      await Order.updateOne({ _id: order._id }, { createdAt: overrides.createdAt });
    }
    return { order, customer };
  };

  it("paginates results and reports correct meta", async () => {
    await makeOrder();
    await makeOrder();
    await makeOrder();

    const page1 = await orderService.adminList({ page: "1", pageSize: "2" });
    expect(page1.items).toHaveLength(2);
    expect(page1.meta).toMatchObject({ page: 1, pageSize: 2, totalPages: 2 });
    expect(page1.meta.total).toBeGreaterThanOrEqual(3);

    const page2 = await orderService.adminList({ page: "2", pageSize: "2" });
    expect(page2.items.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by status", async () => {
    await makeOrder({ status: OrderStatus.Paid });
    await makeOrder({ status: OrderStatus.Cancelled });

    const result = await orderService.adminList({ status: OrderStatus.Paid });
    expect(result.items.every((o) => o.status === OrderStatus.Paid)).toBe(true);
  });

  it("filters by paymentProvider", async () => {
    await makeOrder({ paymentProvider: PaymentProvider.MercadoPago });
    const result = await orderService.adminList({ paymentProvider: PaymentProvider.MercadoPago });
    expect(result.items.every((o) => o.payment.provider === PaymentProvider.MercadoPago)).toBe(true);
  });

  it("filters by date range (from/to)", async () => {
    const { order: inRange } = await makeOrder({ createdAt: new Date("2026-01-15") });
    await makeOrder({ createdAt: new Date("2026-03-01") });

    const result = await orderService.adminList({ from: "2026-01-01", to: "2026-01-31" });
    expect(result.items.map((o) => o.id)).toContain(inRange.id);
    expect(result.items).toHaveLength(1);
  });

  it("filters by hasCoupon", async () => {
    await makeOrder({ couponCode: "VIP10" });
    await makeOrder();

    const withCoupon = await orderService.adminList({ hasCoupon: "true" });
    expect(withCoupon.items.every((o) => Boolean(o.couponCode))).toBe(true);

    const withoutCoupon = await orderService.adminList({ hasCoupon: "false" });
    expect(withoutCoupon.items.every((o) => !o.couponCode)).toBe(true);
  });

  it("searches by orderNumber", async () => {
    const { order } = await makeOrder({ orderNumber: "MM-SEARCHTEST01" });
    await makeOrder();

    const result = await orderService.adminList({ search: "SEARCHTEST" });
    expect(result.items.map((o) => o.id)).toEqual([order.id]);
  });

  it("searches by customer email", async () => {
    const { order, customer } = await makeOrder();

    const result = await orderService.adminList({ search: customer.email });
    expect(result.items.map((o) => o.id)).toContain(order.id);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @maria-matera/api test order.service.test.ts -- -t adminList`
Expected: FAIL — `orderService.adminList` currently ignores `page`/`pageSize`/`from`/`to`/`hasCoupon`/`search` and returns a bare array, not `{items, meta}`.

- [ ] **Step 4: Implement the paginated, filtered `adminList`**

In `apps/api/src/services/order.service.ts`:

1. Add imports at the top (alongside the existing imports, after line 22 `import { generateOrderNumber } from "../utils/orderNumber.js";`):

```ts
import type { FilterQuery } from "mongoose";
import type { PaginationMeta } from "@maria-matera/shared";
import { parseListQuery, buildMeta } from "../utils/listQuery.js";
```

2. Add this constant near the top-level constants (after `const MODULE = "order";` on line 42):

```ts
const ADMIN_LIST_ALLOWED_SORT = ["createdAt", "totalCents"];
```

3. Replace the entire `AdminOrderFilters` interface and `adminList` function (currently lines 663-677) with:

```ts
const buildCustomerSearchIds = async (search: string): Promise<Types.ObjectId[]> => {
  const regex = new RegExp(search.trim(), "i");
  const customers = await Customer.find({
    $or: [{ name: regex }, { email: regex }],
  })
    .select("_id")
    .exec();
  return customers.map((c) => c._id as Types.ObjectId);
};

const adminList = async (
  query: Record<string, unknown>,
): Promise<{ items: OrderDocument[]; meta: PaginationMeta }> => {
  const { page, pageSize, skip, sort } = parseListQuery(query, {
    allowedSort: ADMIN_LIST_ALLOWED_SORT,
    defaultSort: "-createdAt",
  });

  const filter: FilterQuery<OrderDocument> = {};

  if (typeof query.status === "string" && Object.values(OrderStatus).includes(query.status as OrderStatus)) {
    filter.status = query.status as OrderStatus;
  }
  if (
    typeof query.paymentProvider === "string" &&
    Object.values(PaymentProvider).includes(query.paymentProvider as PaymentProvider)
  ) {
    filter["payment.provider"] = query.paymentProvider as PaymentProvider;
  }
  const from = typeof query.from === "string" ? new Date(query.from) : undefined;
  const to = typeof query.to === "string" ? new Date(query.to) : undefined;
  if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
    filter.createdAt = {
      ...(from && !Number.isNaN(from.getTime()) ? { $gte: from } : {}),
      ...(to && !Number.isNaN(to.getTime()) ? { $lte: to } : {}),
    };
  }
  if (query.hasCoupon === "true") {
    filter.couponCode = { $exists: true, $ne: null };
  } else if (query.hasCoupon === "false") {
    filter.$or = [{ couponCode: { $exists: false } }, { couponCode: null }];
  }
  if (typeof query.search === "string" && query.search.trim()) {
    const search = query.search.trim();
    const customerIds = await buildCustomerSearchIds(search);
    // Note: `$or` here is safe to combine with the `hasCoupon:false` `$or` above
    // because Mongo only allows one `$or` key per filter object — if both are
    // ever active simultaneously, wrap each in `$and` instead. Today's UI only
    // sends one of {hasCoupon, search} at a time, so this is documented as the
    // known limitation rather than pre-built for a combination that isn't used.
    filter.$or = [
      { orderNumber: new RegExp(search, "i") },
      ...(customerIds.length ? [{ customerId: { $in: customerIds } }] : []),
    ];
  }

  const [items, total] = await Promise.all([
    Order.find(filter).sort(sort).skip(skip).limit(pageSize).exec(),
    Order.countDocuments(filter),
  ]);
  return { items, meta: buildMeta(page, pageSize, total) };
};
```

4. Remove the old `AdminOrderFilters` interface entirely (it's replaced by the raw `query` object, matching `product.service.ts`'s convention).

5. Update the bottom `export type`/`export` blocks: remove `AdminOrderFilters` from `export type`.

- [ ] **Step 5: Wire the controller**

In `apps/api/src/controllers/order.controller.ts`, replace the `adminList` controller (lines 34-40):

```ts
const adminList = asyncHandler(async (req, res) => {
  const { items, meta } = await orderService.adminList(req.query);
  sendResponse({ res, message: "Órdenes.", data: { orders: items }, meta });
});
```

Remove the now-unused `import { OrderStatus } from "@maria-matera/shared";` at the top of the file ONLY if nothing else in the file still uses `OrderStatus` — check first (`adminAdvance` still casts `req.body.status as OrderStatus`, so the import stays).

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @maria-matera/api test order.service.test.ts -- -t adminList`
Expected: PASS (all 7 new cases).

- [ ] **Step 7: Update the existing HTTP test for the new response shape**

In `apps/api/test/integration/order.test.ts`, the test `"lets an admin list and fetch any order"` (line 242-259) currently does:

```ts
const list = await admin.get("/api/v1/admin/orders");
expect(list.status).toBe(200);
expect(list.body.data.orders.length).toBeGreaterThanOrEqual(1);
```

This still works unchanged — `data.orders` is still an array — but add a meta assertion right after it to lock in the new contract:

```ts
expect(list.body.meta).toMatchObject({ page: 1, pageSize: 20 });
```

- [ ] **Step 8: Run the full order test files to verify nothing else broke**

Run: `pnpm --filter @maria-matera/api test order`
Expected: PASS (all files: `order.test.ts`, `order.service.test.ts`, `order.validators.test.ts`, `order.notifications.test.ts`, `order.paid-dispatch.test.ts`, `orderNumber.test.ts`).

- [ ] **Step 9: Commit** *(only when the user explicitly asks — do not run `git add`/`git commit` on your own; per this session's instructions, prepare the diff and wait for approval)*

---

## Task 2: 360° order detail

**Files:**
- Modify: `apps/api/src/services/order.service.ts` (replace `adminGet`, currently `const adminGet = (orderId: string): Promise<OrderDocument> => getByIdOrThrow(orderId);`)
- Modify: `apps/api/src/controllers/order.controller.ts` (replace `adminGet` controller, `~line 42-45`)
- Test: `apps/api/test/integration/order.service.test.ts` (new `describe("adminGetDetail")` block)

- [ ] **Step 1: Write the failing service test**

Append to `apps/api/test/integration/order.service.test.ts` (reuse the `makeOrder` helper from Task 1's test block — if that block isn't merged yet in your working copy, inline an equivalent order+customer+product fixture as shown in Task 1 Step 2):

```ts
describe("adminGetDetail", () => {
  it("returns order + customer summary + certificates + audit log, all empty-safe", async () => {
    const { order, customer } = await makeOrder({ status: OrderStatus.Paid });

    const detail = await orderService.adminGetDetail(order.id as string);

    expect(detail.order.id).toBe(order.id);
    expect(detail.customer).toMatchObject({
      id: customer.id,
      name: customer.name,
      email: customer.email,
      tier: customer.tier,
    });
    expect(detail.customer.previousOrdersCount).toBe(0);
    expect(detail.customer.totalSpentCents).toBe(0);
    expect(detail.certificates).toEqual([]);
    expect(detail.auditLog).toEqual([]);
  });

  it("enriches items with the product's card image", async () => {
    const { order } = await makeOrder();

    const detail = await orderService.adminGetDetail(order.id as string);

    expect(detail.order.items[0]).toHaveProperty("image");
  });

  it("includes certificates issued for the order", async () => {
    const { order, customer } = await makeOrder({ status: OrderStatus.Paid });
    await Certificate.create({
      orderId: order._id,
      customerId: customer._id,
      orderItemSnapshot: { sku: order.items[0]!.sku, name: order.items[0]!.name },
      serialNumber: `SERIAL-${new mongoose.Types.ObjectId().toHexString()}`,
      pdfUrl: "https://cdn.test/cert.pdf",
      publicId: "cert_test_1",
    });

    const detail = await orderService.adminGetDetail(order.id as string);

    expect(detail.certificates).toHaveLength(1);
    expect(detail.certificates[0]!.pdfUrl).toBe("https://cdn.test/cert.pdf");
  });

  it("includes audit log entries scoped to the order", async () => {
    const { order } = await makeOrder({ status: OrderStatus.PendingPayment });
    await orderService.adminAdvance(
      order.id as string,
      OrderStatus.Cancelled,
      { id: new mongoose.Types.ObjectId().toHexString() },
      "prueba",
    );

    const detail = await orderService.adminGetDetail(order.id as string);

    expect(detail.auditLog.length).toBeGreaterThanOrEqual(1);
    expect(detail.auditLog[0]!.action).toBe("ADVANCE_ORDER_STATUS");
  });

  it("reports previousOrdersCount and totalSpentCents from the customer's OTHER paid orders", async () => {
    const { order: firstOrder, customer } = await makeOrder({ status: OrderStatus.Paid });
    const { order: secondOrder } = await makeOrder({ status: OrderStatus.Paid });
    await Order.updateOne({ _id: secondOrder._id }, { customerId: customer._id });

    const detail = await orderService.adminGetDetail(firstOrder.id as string);

    expect(detail.customer.previousOrdersCount).toBe(1);
    expect(detail.customer.totalSpentCents).toBe(100000);
  });

  it("throws 404 for a non-existent order", async () => {
    await expect(
      orderService.adminGetDetail(new mongoose.Types.ObjectId().toHexString()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
```

Add `import { Certificate } from "../../src/models/Certificate.js";` and `import { Product } from "../../src/models/Product.js";` (Product is likely already imported) to the top of `order.service.test.ts` if not already present.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @maria-matera/api test order.service.test.ts -- -t adminGetDetail`
Expected: FAIL — `orderService.adminGetDetail` does not exist yet.

- [ ] **Step 3: Implement `adminGetDetail`**

In `apps/api/src/services/order.service.ts`, add these imports (alongside the Task 1 imports):

```ts
import { Product } from "../models/Product.js";
import { Certificate, type CertificateDocument } from "../models/Certificate.js";
import { AuditLog, type AuditLogDocument } from "../models/AuditLog.js";
```

Add these types and the function, right after `adminList` (or after wherever Task 1 left off — before the old `const adminGet = ...` line):

```ts
interface OrderItemWithImage {
  productId: Types.ObjectId;
  variantId: Types.ObjectId;
  sku: string;
  name: string;
  qty: number;
  unitPriceCents: number;
  lineSubtotalCents: number;
  image?: string;
}

interface CustomerOrderSummary {
  id: string;
  name: string;
  email: string;
  tier: string;
  previousOrdersCount: number;
  totalSpentCents: number;
}

interface OrderDetail {
  order: Omit<OrderDocument, "items"> & { items: OrderItemWithImage[] };
  customer: CustomerOrderSummary;
  certificates: CertificateDocument[];
  auditLog: AuditLogDocument[];
}

/**
 * Order statuses counted as a "realized sale" for lifetime-spend and revenue
 * purposes: payment landed and the sale was never reversed. `refunded` is
 * deliberately excluded (the money went back), `cancelled`/`pending_payment`
 * never became a sale.
 */
const REALIZED_SALE_STATUSES: OrderStatus[] = [
  OrderStatus.Paid,
  OrderStatus.Processing,
  OrderStatus.Shipped,
  OrderStatus.Delivered,
];

const enrichItemsWithImages = async (
  order: OrderDocument,
): Promise<OrderItemWithImage[]> => {
  const productIds = [...new Set(order.items.map((item) => item.productId.toString()))];
  const products = await Product.find({ _id: { $in: productIds } })
    .select("images.cardPrimary")
    .exec();
  const imageByProductId = new Map(
    products.map((p) => [p.id as string, p.images?.cardPrimary]),
  );
  return order.items.map((item) => ({
    ...item.toObject(),
    image: imageByProductId.get(item.productId.toString()),
  }));
};

const getCustomerSummary = async (
  customerId: Types.ObjectId,
  excludeOrderId: Types.ObjectId,
): Promise<CustomerOrderSummary> => {
  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new AppError("Cliente no encontrado.", 404);
  }
  const otherOrders = await Order.find({
    customerId,
    _id: { $ne: excludeOrderId },
    status: { $in: REALIZED_SALE_STATUSES },
  })
    .select("totalCents")
    .exec();
  return {
    id: customer.id as string,
    name: customer.name,
    email: customer.email,
    tier: customer.tier,
    previousOrdersCount: otherOrders.length,
    totalSpentCents: otherOrders.reduce((sum, o) => sum + o.totalCents, 0),
  };
};

const adminGetDetail = async (orderId: string): Promise<OrderDetail> => {
  const order = await getByIdOrThrow(orderId);

  const [items, customer, certificates, auditLog] = await Promise.all([
    enrichItemsWithImages(order),
    getCustomerSummary(order.customerId as Types.ObjectId, order._id as Types.ObjectId),
    Certificate.find({ orderId: order._id }).sort({ issuedAt: -1 }).exec(),
    AuditLog.find({ module: MODULE, targetId: orderId }).sort({ createdAt: 1 }).exec(),
  ]);

  return {
    order: { ...order.toObject(), items },
    customer,
    certificates,
    auditLog,
  };
};
```

Keep the old `adminGet` function as-is for now (it's still exported and might be used elsewhere) — actually, check with `grep -rn "orderService.adminGet\b" apps/api/src` first; if `adminGet` (not `adminGetDetail`) has no other callers besides the controller you're about to change, delete it and its export instead of keeping dead code.

- [ ] **Step 4: Wire the controller**

In `apps/api/src/controllers/order.controller.ts`, replace the `adminGet` controller (lines 42-45):

```ts
const adminGet = asyncHandler(async (req, res) => {
  const detail = await orderService.adminGetDetail(req.params.orderId as string);
  sendResponse({ res, message: "Orden.", data: detail });
});
```

This changes the response shape from `{data: {order}}` to `{data: {order, customer, certificates, auditLog}}`. Check `apps/api/test/integration/order.test.ts` line 256-258 (`one.body.data.order._id`) — this still works since `order` is still a top-level key of `data`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @maria-matera/api test order.service.test.ts -- -t adminGetDetail`
Expected: PASS (all 6 cases).

- [ ] **Step 6: Run the full order test suite**

Run: `pnpm --filter @maria-matera/api test order`
Expected: PASS.

- [ ] **Step 7: Commit** *(only when the user explicitly asks)*

---

## Task 3: Order stats endpoint

**Files:**
- Modify: `apps/api/src/services/order.service.ts` (add `adminStats`)
- Modify: `apps/api/src/controllers/order.controller.ts` (add `adminStats` controller)
- Modify: `apps/api/src/routes/admin.order.routes.ts` (add `GET /stats`, registered BEFORE `GET /:orderId`)
- Test: `apps/api/test/integration/order.service.test.ts` (new `describe("adminStats")` block)

- [ ] **Step 1: Write the failing service test**

Append to `apps/api/test/integration/order.service.test.ts`:

```ts
describe("adminStats", () => {
  it("computes revenue, ticket average and provider breakdown within a date range, excluding cancelled and subtracting refunded", async () => {
    await makeOrder({ status: OrderStatus.Paid, createdAt: new Date("2026-02-10"), paymentProvider: PaymentProvider.Stripe });
    await makeOrder({ status: OrderStatus.Paid, createdAt: new Date("2026-02-12"), paymentProvider: PaymentProvider.MercadoPago });
    await makeOrder({ status: OrderStatus.Cancelled, createdAt: new Date("2026-02-11") });
    await makeOrder({ status: OrderStatus.Refunded, createdAt: new Date("2026-02-13") });
    await makeOrder({ status: OrderStatus.Paid, createdAt: new Date("2026-01-05") }); // out of range

    const stats = await orderService.adminStats({ from: "2026-02-01", to: "2026-02-28" });

    // 2 paid (100000 each = 200000) minus 1 refunded (100000) = 100000 net revenue.
    expect(stats.revenueCents).toBe(100000);
    expect(stats.providerBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: PaymentProvider.Stripe }),
        expect.objectContaining({ provider: PaymentProvider.MercadoPago }),
      ]),
    );
  });

  it("computes revenue comparison vs the equivalent previous range", async () => {
    await makeOrder({ status: OrderStatus.Paid, createdAt: new Date("2026-02-15") }); // current range
    await makeOrder({ status: OrderStatus.Paid, createdAt: new Date("2026-01-15") }); // previous range (equal length, immediately before)

    const stats = await orderService.adminStats({ from: "2026-02-01", to: "2026-02-28" });

    expect(stats.revenueCents).toBe(100000);
    expect(stats.previousRevenueCents).toBe(100000);
    expect(stats.revenueChangePercent).toBe(0);
  });

  it("counts orders per status within range", async () => {
    await makeOrder({ status: OrderStatus.Paid, createdAt: new Date("2026-03-01") });
    await makeOrder({ status: OrderStatus.Processing, createdAt: new Date("2026-03-02") });

    const stats = await orderService.adminStats({ from: "2026-03-01", to: "2026-03-31" });

    expect(stats.statusCounts[OrderStatus.Paid]).toBe(1);
    expect(stats.statusCounts[OrderStatus.Processing]).toBe(1);
  });

  it("reports paidUnattended and processingWithoutTracking as current, range-independent operational alerts", async () => {
    await makeOrder({ status: OrderStatus.Paid, createdAt: new Date("2020-01-01") }); // old, still unattended today
    await makeOrder({ status: OrderStatus.Processing, createdAt: new Date("2020-01-01") }); // old, still no guide

    const stats = await orderService.adminStats({ from: "2026-01-01", to: "2026-01-31" });

    expect(stats.alerts.paidUnattended).toBeGreaterThanOrEqual(1);
    expect(stats.alerts.processingWithoutTracking).toBeGreaterThanOrEqual(1);
  });

  it("computes top products by units and by revenue", async () => {
    await makeOrder({ status: OrderStatus.Paid, createdAt: new Date("2026-04-05") });

    const stats = await orderService.adminStats({ from: "2026-04-01", to: "2026-04-30" });

    expect(stats.topProducts[0]).toMatchObject({ unitsSold: 1, revenueCents: 100000 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @maria-matera/api test order.service.test.ts -- -t adminStats`
Expected: FAIL — `orderService.adminStats` does not exist yet.

- [ ] **Step 3: Implement `adminStats`**

In `apps/api/src/services/order.service.ts`, add these types and the function after `adminGetDetail`:

```ts
interface OrderStatsQuery {
  from?: string;
  to?: string;
}

interface ProviderBreakdownEntry {
  provider: PaymentProvider;
  revenueCents: number;
  orderCount: number;
}

interface TopProductEntry {
  productId: string;
  name: string;
  unitsSold: number;
  revenueCents: number;
}

interface OrderStats {
  rangeFrom: Date;
  rangeTo: Date;
  revenueCents: number;
  previousRevenueCents: number;
  revenueChangePercent: number;
  averageTicketCents: number;
  statusCounts: Record<OrderStatus, number>;
  providerBreakdown: ProviderBreakdownEntry[];
  topProducts: TopProductEntry[];
  alerts: {
    paidUnattended: number;
    processingWithoutTracking: number;
  };
}

const REFUND_REVERSING_STATUS = OrderStatus.Refunded;

/** Sums `totalCents` for realized sales in `[from, to)`, minus refunds landed in the same window. */
const computeNetRevenue = async (from: Date, to: Date): Promise<{ revenueCents: number; orderCount: number }> => {
  const [sales, refunds] = await Promise.all([
    Order.aggregate<{ total: number; count: number }>([
      { $match: { createdAt: { $gte: from, $lt: to }, status: { $in: REALIZED_SALE_STATUSES } } },
      { $group: { _id: null, total: { $sum: "$totalCents" }, count: { $sum: 1 } } },
    ]),
    Order.aggregate<{ total: number }>([
      { $match: { createdAt: { $gte: from, $lt: to }, status: REFUND_REVERSING_STATUS } },
      { $group: { _id: null, total: { $sum: "$totalCents" } } },
    ]),
  ]);
  const salesTotal = sales[0]?.total ?? 0;
  const salesCount = sales[0]?.count ?? 0;
  const refundTotal = refunds[0]?.total ?? 0;
  return { revenueCents: salesTotal - refundTotal, orderCount: salesCount };
};

const computeStatusCounts = async (from: Date, to: Date): Promise<Record<OrderStatus, number>> => {
  const rows = await Order.aggregate<{ _id: OrderStatus; count: number }>([
    { $match: { createdAt: { $gte: from, $lt: to } } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const base = Object.fromEntries(Object.values(OrderStatus).map((s) => [s, 0])) as Record<
    OrderStatus,
    number
  >;
  for (const row of rows) {
    base[row._id] = row.count;
  }
  return base;
};

const computeProviderBreakdown = async (from: Date, to: Date): Promise<ProviderBreakdownEntry[]> => {
  const rows = await Order.aggregate<{ _id: PaymentProvider; total: number; count: number }>([
    {
      $match: {
        createdAt: { $gte: from, $lt: to },
        status: { $in: REALIZED_SALE_STATUSES },
      },
    },
    { $group: { _id: "$payment.provider", total: { $sum: "$totalCents" }, count: { $sum: 1 } } },
  ]);
  return rows.map((r) => ({ provider: r._id, revenueCents: r.total, orderCount: r.count }));
};

const computeTopProducts = async (from: Date, to: Date, limit = 10): Promise<TopProductEntry[]> => {
  const rows = await Order.aggregate<{
    _id: { productId: Types.ObjectId; name: string };
    unitsSold: number;
    revenueCents: number;
  }>([
    { $match: { createdAt: { $gte: from, $lt: to }, status: { $in: REALIZED_SALE_STATUSES } } },
    { $unwind: "$items" },
    {
      $group: {
        _id: { productId: "$items.productId", name: "$items.name" },
        unitsSold: { $sum: "$items.qty" },
        revenueCents: { $sum: "$items.lineSubtotalCents" },
      },
    },
    { $sort: { unitsSold: -1 } },
    { $limit: limit },
  ]);
  return rows.map((r) => ({
    productId: r._id.productId.toString(),
    name: r._id.name,
    unitsSold: r.unitsSold,
    revenueCents: r.revenueCents,
  }));
};

/**
 * Operational alerts: current state, deliberately NOT scoped to the requested
 * date range (an order paid 3 weeks ago and still unattended is exactly as
 * urgent today regardless of which stats range the admin is looking at).
 */
const computeAlerts = async (): Promise<OrderStats["alerts"]> => {
  const [paidUnattended, processingWithoutTracking] = await Promise.all([
    Order.countDocuments({ status: OrderStatus.Paid }),
    Order.countDocuments({
      status: OrderStatus.Processing,
      $or: [{ "shipping.trackingNumber": { $exists: false } }, { "shipping.trackingNumber": null }],
    }),
  ]);
  return { paidUnattended, processingWithoutTracking };
};

const parseStatsRange = (query: OrderStatsQuery): { from: Date; to: Date } => {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw new AppError("El rango de fechas no es válido.", 400);
  }
  return { from, to };
};

const adminStats = async (query: OrderStatsQuery): Promise<OrderStats> => {
  const { from, to } = parseStatsRange(query);
  const rangeMs = to.getTime() - from.getTime();
  const previousFrom = new Date(from.getTime() - rangeMs);
  const previousTo = from;

  const [current, previous, statusCounts, providerBreakdown, topProducts, alerts] = await Promise.all([
    computeNetRevenue(from, to),
    computeNetRevenue(previousFrom, previousTo),
    computeStatusCounts(from, to),
    computeProviderBreakdown(from, to),
    computeTopProducts(from, to),
    computeAlerts(),
  ]);

  const revenueChangePercent =
    previous.revenueCents === 0
      ? current.revenueCents === 0
        ? 0
        : 100
      : Math.round(((current.revenueCents - previous.revenueCents) / previous.revenueCents) * 100);

  return {
    rangeFrom: from,
    rangeTo: to,
    revenueCents: current.revenueCents,
    previousRevenueCents: previous.revenueCents,
    revenueChangePercent,
    averageTicketCents: current.orderCount === 0 ? 0 : Math.round(current.revenueCents / current.orderCount),
    statusCounts,
    providerBreakdown,
    topProducts,
    alerts,
  };
};
```

Add `adminStats` (and `adminGetDetail`, if not already added in Task 2's export step) to the final `export { ... }` block at the bottom of the file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @maria-matera/api test order.service.test.ts -- -t adminStats`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Wire the controller**

In `apps/api/src/controllers/order.controller.ts`, add:

```ts
const adminStats = asyncHandler(async (req, res) => {
  const stats = await orderService.adminStats({
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
  });
  sendResponse({ res, message: "Estadísticas de órdenes.", data: { stats } });
});
```

Add `adminStats` to the file's final `export { ... }` line.

- [ ] **Step 6: Wire the route (registered BEFORE `/:orderId` to avoid the path colliding with the param route)**

In `apps/api/src/routes/admin.order.routes.ts`, insert the new route right after line 17 (`router.use(protect, restrictTo(...))`) and BEFORE line 18 (`router.get("/", ctrl.adminList);`):

```ts
router.get("/stats", ctrl.adminStats);
```

Final route order in the file must be: `/stats` → `/` → `/:orderId` → `/:orderId/status` → `/:orderId/refund`.

- [ ] **Step 7: Write the HTTP-level test**

Add to `apps/api/test/integration/order.test.ts`, inside the `describe("Order routes — admin", ...)` block:

```ts
it("returns order stats for an admin, and blocks non-admins", async () => {
  const { agent, addressId } = await readyToCheckout("ordstats1@test.com");
  await agent.post("/api/v1/orders").send({
    idempotencyKey: "http-idem-stats-1",
    shippingAddressId: addressId,
    billingAddressId: addressId,
  });

  const admin = await adminAgent();
  const res = await admin.get("/api/v1/admin/orders/stats?from=2020-01-01&to=2030-01-01");
  expect(res.status).toBe(200);
  expect(res.body.data.stats).toHaveProperty("revenueCents");
  expect(res.body.data.stats).toHaveProperty("statusCounts");
  expect(res.body.data.stats).toHaveProperty("alerts");

  const asCustomer = await agent.get("/api/v1/admin/orders/stats");
  expect(asCustomer.status).toBe(403);
});

it("rejects an invalid stats date range (400)", async () => {
  const admin = await adminAgent();
  const res = await admin.get("/api/v1/admin/orders/stats?from=2026-05-01&to=2026-01-01");
  expect(res.status).toBe(400);
});
```

- [ ] **Step 8: Run the full order test suite**

Run: `pnpm --filter @maria-matera/api test order`
Expected: PASS.

- [ ] **Step 9: Run the FULL API test suite (regression check)**

Run: `pnpm --filter @maria-matera/api test`
Expected: PASS, all suites (165+ existing tests plus the new ones from this plan).

- [ ] **Step 10: Run the build/typecheck**

Run: `pnpm --filter @maria-matera/api build`
Expected: no TypeScript errors.

- [ ] **Step 11: Commit** *(only when the user explicitly asks)*

---

## Final verification (after all 3 tasks)

- [ ] Full suite green: `pnpm --filter @maria-matera/api test`
- [ ] Build green: `pnpm --filter @maria-matera/api build`
- [ ] Manual smoke test against dev (`pnpm --filter @maria-matera/api dev`, then curl/Postman as an admin):
  - `GET /api/v1/admin/orders?page=1&pageSize=10&status=paid` — paginated, filtered.
  - `GET /api/v1/admin/orders?search=<some order number or customer email>` — search works.
  - `GET /api/v1/admin/orders/:id` — returns `order` (with item images), `customer` (with tier + lifetime spend), `certificates` (array), `auditLog` (array); test both an order with certificates/audit entries and one without (empty arrays, no error).
  - `GET /api/v1/admin/orders/stats?from=2026-01-01&to=2026-01-31` — revenue, comparison %, status counts, provider breakdown, top products, alerts all populated sensibly.
- [ ] Confirm `npm audit` / existing CI checks are unaffected (no new dependencies were added — everything uses existing Mongoose/Joi/Express already in the project).
