import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { AdminRole, OrderStatus, PaymentProvider } from "@maria-matera/shared";
import { buildApp } from "../../src/app.js";
import { AdminUser } from "../../src/models/AdminUser.js";
import { Certificate } from "../../src/models/Certificate.js";
import { Customer } from "../../src/models/Customer.js";
import { Order } from "../../src/models/Order.js";
import * as certificateService from "../../src/services/certificate.service.js";

/**
 * Admin certificate listing (Bloque 2, dashboard). The one new read: a
 * paginated/searchable list joining each certificate to its order number and
 * customer. Issuance/reissue/download stay covered by their own test files.
 */

const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));

const ADMIN_PASSWORD = "AdminPass123";
let counter = 0;

const address = {
  label: "Casa",
  line1: "Av. Reforma 123",
  city: "CDMX",
  state: "CDMX",
  zip: "06600",
  country: "México",
};

const makeIssued = async (
  overrides: Partial<{
    serialNumber: string;
    sku: string;
    itemName: string;
    customerName: string;
    issuedAt: Date;
  }> = {},
) => {
  counter += 1;
  const customer = await Customer.create({
    name: overrides.customerName ?? `Clienta Cert ${counter}`,
    email: `cert-admin-${counter}@test.com`,
    password: "Password123",
  });
  const order = await Order.create({
    customerId: customer._id,
    orderNumber: `MM-${new mongoose.Types.ObjectId().toHexString().toUpperCase()}`,
    items: [
      {
        productId: new mongoose.Types.ObjectId(),
        variantId: new mongoose.Types.ObjectId(),
        sku: overrides.sku ?? `CERT-SKU-${counter}`,
        name: overrides.itemName ?? "Anillo Certificado",
        qty: 1,
        unitPriceCents: 100000,
        lineSubtotalCents: 100000,
      },
    ],
    shippingAddress: address,
    billingAddress: address,
    subtotalCents: 100000,
    shippingCostCents: 0,
    totalCents: 100000,
    status: OrderStatus.Paid,
    payment: { provider: PaymentProvider.Stripe, status: "paid" },
    idempotencyKey: `idem-cert-admin-${counter}`,
    reservationId: new mongoose.Types.ObjectId(),
    reservationExpiresAt: new Date(Date.now() + 60_000),
  });
  const certificate = await Certificate.create({
    orderId: order._id,
    customerId: customer._id,
    orderItemSnapshot: {
      sku: overrides.sku ?? `CERT-SKU-${counter}`,
      name: overrides.itemName ?? "Anillo Certificado",
    },
    serialNumber:
      overrides.serialNumber ?? `SER-${new mongoose.Types.ObjectId().toHexString().toUpperCase()}`,
    pdfUrl: "https://cdn.test/cert.pdf",
    publicId: `cert_admin_${counter}`,
    ...(overrides.issuedAt ? { issuedAt: overrides.issuedAt } : {}),
  });
  return { certificate, order, customer };
};

const adminAgent = async () => {
  counter += 1;
  await AdminUser.create({
    username: `cert-list-admin-${counter}`,
    email: `cert-list-admin-${counter}@test.com`,
    password: ADMIN_PASSWORD,
    role: AdminRole.Admin,
  });
  const agent = request.agent(app);
  await agent
    .post("/api/v1/admin/auth/login")
    .send({ email: `cert-list-admin-${counter}@test.com`, password: ADMIN_PASSWORD });
  return agent;
};

describe("Certificate adminList (service)", () => {
  it("lists certificates newest-first with order number and customer info, paginated", async () => {
    const { certificate, order, customer } = await makeIssued({
      issuedAt: new Date("2026-07-01"),
    });
    await makeIssued({ issuedAt: new Date("2026-07-10") });

    const result = await certificateService.adminList({ page: "1", pageSize: "10" });

    expect(result.meta.total).toBeGreaterThanOrEqual(2);
    // Default sort: newest issuedAt first.
    const issued = result.items.map((r) => new Date(r.issuedAt).getTime());
    expect(issued).toEqual([...issued].sort((a, b) => b - a));

    const row = result.items.find((r) => r.serialNumber === certificate.serialNumber)!;
    expect(row).toBeDefined();
    expect(row.sku).toBe(certificate.orderItemSnapshot.sku);
    expect(row.itemName).toBe(certificate.orderItemSnapshot.name);
    expect(row.orderNumber).toBe(order.orderNumber);
    expect(row.customerName).toBe(customer.name);
    expect(row.customerEmail).toBe(customer.email);
    expect(row.pdfUrl).toBe("https://cdn.test/cert.pdf");
  });

  it("filters by issuedAt date range", async () => {
    const { certificate: inRange } = await makeIssued({ issuedAt: new Date("2026-01-15") });
    await makeIssued({ issuedAt: new Date("2026-03-15") });

    const result = await certificateService.adminList({ from: "2026-01-01", to: "2026-01-31" });

    expect(result.items.map((r) => r.serialNumber)).toEqual([inRange.serialNumber]);
  });

  it("searches by serial, by SKU and by item name", async () => {
    const { certificate } = await makeIssued({
      serialNumber: "SER-BUSCAME-001",
      sku: "SKU-UNICO-XYZ",
      itemName: "Collar Único Especial",
    });
    await makeIssued();

    const bySerial = await certificateService.adminList({ search: "BUSCAME" });
    expect(bySerial.items.map((r) => r.serialNumber)).toEqual([certificate.serialNumber]);

    const bySku = await certificateService.adminList({ search: "UNICO-XYZ" });
    expect(bySku.items.map((r) => r.serialNumber)).toEqual([certificate.serialNumber]);

    const byName = await certificateService.adminList({ search: "Collar Único" });
    expect(byName.items.map((r) => r.serialNumber)).toEqual([certificate.serialNumber]);
  });

  it("searches by order number and by customer email", async () => {
    const { certificate, order, customer } = await makeIssued();
    await makeIssued();

    const byOrder = await certificateService.adminList({ search: order.orderNumber });
    expect(byOrder.items.map((r) => r.serialNumber)).toEqual([certificate.serialNumber]);

    const byEmail = await certificateService.adminList({ search: customer.email });
    expect(byEmail.items.map((r) => r.serialNumber)).toEqual([certificate.serialNumber]);
  });
});

describe("Certificate admin HTTP list", () => {
  it("blocks anonymous (401) and returns the list for an admin", async () => {
    const anon = await request(app).get("/api/v1/admin/certificates");
    expect(anon.status).toBe(401);

    await makeIssued();
    const admin = await adminAgent();

    const res = await admin.get("/api/v1/admin/certificates");
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.items[0]).toHaveProperty("serialNumber");
    expect(res.body.data.items[0]).toHaveProperty("orderNumber");
    expect(res.body.meta).toMatchObject({ page: 1 });
  });
});
