import { describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";

describe("env", () => {
  it("exposes Mercado Pago credentials", () => {
    expect(env.mercadoPagoAccessToken).toBe("TEST-mp-access-token-placeholder-000000000000");
    expect(env.mercadoPagoWebhookSecret).toBe("mp-webhook-secret-placeholder-000000000000");
  });
});
