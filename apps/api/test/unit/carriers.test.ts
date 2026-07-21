import { describe, expect, it } from "vitest";
import { Carrier } from "@maria-matera/shared";
import { buildTrackingUrl } from "../../src/config/carriers.js";

describe("buildTrackingUrl", () => {
  it("builds the DHL tracking URL", () => {
    expect(buildTrackingUrl(Carrier.Dhl, "1234567890")).toBe(
      "https://www.dhl.com/en/express/tracking.html?AWB=1234567890",
    );
  });

  it("builds the FedEx tracking URL", () => {
    expect(buildTrackingUrl(Carrier.FedEx, "1234567890")).toBe(
      "https://www.fedex.com/apps/fedextrack/?tracknumbers=1234567890",
    );
  });

  it("builds the Estafeta tracking URL", () => {
    expect(buildTrackingUrl(Carrier.Estafeta, "1234567890")).toBe(
      "https://www.estafeta.com/Herramientas/Rastreo?waybill=1234567890",
    );
  });

  it("builds the UPS tracking URL", () => {
    expect(buildTrackingUrl(Carrier.Ups, "1234567890")).toBe(
      "https://www.ups.com/track?tracknum=1234567890",
    );
  });

  it("returns undefined for Other (no dead link)", () => {
    expect(buildTrackingUrl(Carrier.Other, "1234567890")).toBeUndefined();
  });

  it("URL-encodes special characters in the tracking number", () => {
    expect(buildTrackingUrl(Carrier.Dhl, "abc def/123")).toBe(
      "https://www.dhl.com/en/express/tracking.html?AWB=abc%20def%2F123",
    );
  });
});
