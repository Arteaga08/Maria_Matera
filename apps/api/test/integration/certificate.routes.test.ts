import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { AdminRole } from "@maria-matera/shared";

/**
 * Certificate HTTP routes (Milestone 8, Task 3). Owner reads under
 * `/api/v1/certificates` (`protect` + `requireCustomer`); admin reissue under
 * `/api/v1/admin/certificates` (`protect` + Admin/Editor); no public route.
 * Mirrors `shipping.routes.test.ts`'s conventions for a real listening server
 * and authenticated agents, but — per this task's brief — seeds orders and
 * certificates via the service layer directly (`order.service.ts` +
 * `certificate.service.ts`, exactly like `certificate.service.test.ts` does)
 * rather than re-testing HTTP checkout.
 */
const stripeMock = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  refund: vi.fn(),
  constructWebhookEvent: vi.fn(),
}));
vi.mock("../../src/services/payment/stripe.provider.js", () => ({ stripeProvider: stripeMock }));

const uploadStreamMock = vi.hoisted(() => vi.fn());
const destroyMock = vi.hoisted(() => vi.fn());
const isCloudinaryConfiguredMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/config/cloudinary.js", () => ({
  cloudinary: { uploader: { upload_stream: uploadStreamMock, destroy: destroyMock } },
  isCloudinaryConfigured: isCloudinaryConfiguredMock,
}));

// `orderService.markPaid` now fires `dispatchPaidSideEffects` in the
// background (Milestone 9), which calls the REAL `issueForOrder` — left
// un-mocked, that would race this file's own explicit `certificateService
// .issueForOrder(paid)` calls (see `seedPaidCertificate` below), both racing
// past the same check-then-create idempotency guard. Mocked away here (via
// `vi.hoisted`, reconfigured in `beforeEach` below, NOT a bare `vi.fn()` in
// the factory — this file's `afterEach(() => vi.restoreAllMocks())` would
// otherwise wipe a factory-only mock back to a no-op after the first test);
// the dispatcher's wiring/internals are covered by
// `order.paid-dispatch.test.ts` and `order.notifications.test.ts`.
const dispatchPaidSideEffectsMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/notification/order.notifications.js", () => ({
  dispatchPaidSideEffects: dispatchPaidSideEffectsMock,
}));

import { buildApp } from "../../src/app.js";
import { emailService } from "../../src/services/email.service.js";
import { AdminUser } from "../../src/models/AdminUser.js";
import { Customer } from "../../src/models/Customer.js";
import { Product } from "../../src/models/Product.js";
import { ProductVariant } from "../../src/models/ProductVariant.js";
import { Cart } from "../../src/models/Cart.js";
import { Certificate } from "../../src/models/Certificate.js";
import * as orderService from "../../src/services/order.service.js";
import * as certificateService from "../../src/services/certificate.service.js";

const app = buildApp().listen();
afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));
afterEach(() => vi.restoreAllMocks());

const PASSWORD = "Password123";
const ADMIN_PASSWORD = "AdminPass123";
let counter = 0;
let piSeq = 0;
let uploadSeq = 0;

beforeEach(() => {
  stripeMock.createPaymentIntent.mockReset();
  stripeMock.createPaymentIntent.mockImplementation(async () => {
    piSeq += 1;
    return { ref: `pi_cert_http_${piSeq}`, clientSecret: `cs_cert_http_${piSeq}` };
  });

  dispatchPaidSideEffectsMock.mockReset();
  dispatchPaidSideEffectsMock.mockResolvedValue(undefined);

  uploadStreamMock.mockReset();
  isCloudinaryConfiguredMock.mockReset();
  isCloudinaryConfiguredMock.mockReturnValue(true);
  uploadSeq = 0;
  uploadStreamMock.mockImplementation((_options, callback) => {
    uploadSeq += 1;
    callback(null, {
      secure_url: `https://res.cloudinary.com/demo/raw/upload/cert-http-${uploadSeq}.pdf`,
      public_id: `certificates/cert-http-${uploadSeq}`,
    });
    return { end: vi.fn() };
  });

  destroyMock.mockReset();
  destroyMock.mockImplementation(
    (_publicId: string, _options: unknown, callback: (error: unknown) => void) => {
      callback(null);
    },
  );
});

const tokenFromUrl = (url: string): string => new URL(url).searchParams.get("token") ?? "";

/** Registers+verifies+logs in a customer via HTTP, returning the agent and their id. */
const registerAndLogin = async (email: string) => {
  let verifyUrl = "";
  const spy = vi
    .spyOn(emailService, "sendVerificationEmail")
    .mockImplementation(async (_to, url) => {
      verifyUrl = url;
    });
  const agent = request.agent(app);
  await agent.post("/api/v1/auth/register").send({ name: "Cliente", email, password: PASSWORD });
  await agent.post("/api/v1/auth/verify-email").send({ token: tokenFromUrl(verifyUrl) });
  await agent.post("/api/v1/auth/login").send({ email, password: PASSWORD });
  spy.mockRestore();
  const customer = await Customer.findOne({ email });
  return { agent, customerId: customer!.id as string };
};

const adminAgent = async () => {
  await AdminUser.create({
    username: `owner-${(counter += 1)}`,
    email: `admin-cert-${counter}@test.com`,
    password: ADMIN_PASSWORD,
    role: AdminRole.Admin,
  });
  const agent = request.agent(app);
  await agent
    .post("/api/v1/admin/auth/login")
    .send({ email: `admin-cert-${counter}@test.com`, password: ADMIN_PASSWORD });
  return agent;
};

/** Adds one shipping/billing address via HTTP, returns its id. */
const seedAddress = async (agent: ReturnType<typeof request.agent>) => {
  const res = await agent.post("/api/v1/addresses").send({
    label: "Casa",
    line1: "Av. Reforma 123",
    city: "CDMX",
    state: "CDMX",
    zip: "06600",
  });
  return res.body.data.address._id as string;
};

/** Seeds one product+variant with 1 unit of stock. */
const seedItem = async () => {
  counter += 1;
  const product = await Product.create({
    name: `Anillo Cert ${counter}`,
    slug: `anillo-cert-http-${counter}`,
    description: "Anillo de oro de 18k con diamante.",
    categoryId: new mongoose.Types.ObjectId(),
    priceCents: 100000,
    isPublished: true,
    isArchived: false,
  });
  const variant = await ProductVariant.create({
    productId: product._id,
    sku: `CERT-HTTP-${counter}`,
    onHand: 10,
  });
  return { product, variant };
};

/**
 * Registers a customer via HTTP (so we get an authenticated agent), then
 * seeds+pays+issues ONE order+certificate for them via the service layer
 * directly (bypassing checkout HTTP, per this task's brief). Returns the
 * agent, the customer id, and the resulting certificate.
 */
const seedCustomerWithCertificate = async (email: string) => {
  const { agent, customerId } = await registerAndLogin(email);
  const addressId = await seedAddress(agent);
  const { product, variant } = await seedItem();

  await Cart.findOneAndUpdate(
    { customerId },
    { $set: { items: [{ productId: product._id, variantId: variant._id, sku: variant.sku, qty: 1 }] } },
    { upsert: true },
  );
  const { order } = await orderService.createOrder(customerId, {
    idempotencyKey: `cert-http-${email}`,
    shippingAddressId: addressId,
    billingAddressId: addressId,
  });
  const paid = await orderService.markPaid(order.id, "admin-seed");
  await certificateService.issueForOrder(paid);
  const certificate = (await Certificate.findOne({ orderId: paid._id }))!;

  return { agent, customerId, certificate };
};

describe("Certificate routes — customer: list", () => {
  it("returns only the authenticated customer's certificates (isolation)", async () => {
    const a = await seedCustomerWithCertificate("certlist1@test.com");
    const b = await seedCustomerWithCertificate("certlist2@test.com");

    const resA = await a.agent.get("/api/v1/certificates");
    expect(resA.status).toBe(200);
    expect(resA.body.data.certificates).toHaveLength(1);
    expect(resA.body.data.certificates[0]._id).toBe(a.certificate.id);

    const resB = await b.agent.get("/api/v1/certificates");
    expect(resB.status).toBe(200);
    expect(resB.body.data.certificates).toHaveLength(1);
    expect(resB.body.data.certificates[0]._id).toBe(b.certificate.id);
  });

  it("rejects an unauthenticated request (401)", async () => {
    const res = await request(app).get("/api/v1/certificates");
    expect(res.status).toBe(401);
  });
});

describe("Certificate routes — customer: download", () => {
  it("returns the pdfUrl for the certificate's owner (200)", async () => {
    const { agent, certificate } = await seedCustomerWithCertificate("certdl1@test.com");

    const res = await agent.get(`/api/v1/certificates/${certificate.id}/download`);
    expect(res.status).toBe(200);
    expect(res.body.data.pdfUrl).toBe(certificate.pdfUrl);
  });

  it("returns 404 for a certificate belonging to a different customer", async () => {
    const { certificate } = await seedCustomerWithCertificate("certdl2@test.com");
    const { agent: otherAgent } = await registerAndLogin("certdl3@test.com");

    const res = await otherAgent.get(`/api/v1/certificates/${certificate.id}/download`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a nonexistent certificate id", async () => {
    const { agent } = await seedCustomerWithCertificate("certdl4@test.com");

    const res = await agent.get(`/api/v1/certificates/${new mongoose.Types.ObjectId().toString()}/download`);
    expect(res.status).toBe(404);
  });

  it("rejects an unauthenticated request (401)", async () => {
    const { certificate } = await seedCustomerWithCertificate("certdl5@test.com");
    const res = await request(app).get(`/api/v1/certificates/${certificate.id}/download`);
    expect(res.status).toBe(401);
  });

  it("returns 400 for a malformed certId (Mongoose CastError, no Joi validator needed)", async () => {
    const { agent } = await seedCustomerWithCertificate("certdl6@test.com");
    const res = await agent.get("/api/v1/certificates/no-es-un-objectid/download");
    expect(res.status).toBe(400);
  });
});

describe("Certificate routes — admin: reissue", () => {
  it("reissues a certificate for an admin (200), returning the updated certificate", async () => {
    const { certificate } = await seedCustomerWithCertificate("certreissue1@test.com");
    const admin = await adminAgent();

    const res = await admin.post(`/api/v1/admin/certificates/${certificate.id}/reissue`);
    expect(res.status).toBe(200);
    expect(res.body.data.certificate._id).toBe(certificate.id);
    expect(res.body.data.certificate.serialNumber).toBe(certificate.serialNumber);
    expect(res.body.data.certificate.pdfUrl).not.toBe(certificate.pdfUrl);
  });

  it("blocks without an admin session (401)", async () => {
    const { certificate } = await seedCustomerWithCertificate("certreissue2@test.com");
    const res = await request(app).post(`/api/v1/admin/certificates/${certificate.id}/reissue`);
    expect(res.status).toBe(401);
  });

  it("blocks an authenticated non-admin customer (403)", async () => {
    const { certificate } = await seedCustomerWithCertificate("certreissue3@test.com");
    const { agent: customerAgent } = await registerAndLogin("certreissue4@test.com");

    const res = await customerAgent.post(`/api/v1/admin/certificates/${certificate.id}/reissue`);
    expect(res.status).toBe(403);
  });

  it("returns 404 for a nonexistent certificate", async () => {
    const admin = await adminAgent();
    const res = await admin.post(
      `/api/v1/admin/certificates/${new mongoose.Types.ObjectId().toString()}/reissue`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed certId (Mongoose CastError, no Joi validator needed)", async () => {
    const admin = await adminAgent();
    const res = await admin.post("/api/v1/admin/certificates/no-es-un-objectid/reissue");
    expect(res.status).toBe(400);
  });
});
