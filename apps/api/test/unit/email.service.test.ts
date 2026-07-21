import { beforeEach, describe, expect, it, vi } from "vitest";
import { Carrier } from "@maria-matera/shared";

/**
 * `sendShippedEmail` (Milestone 7, Task 3). The transport is mocked at the
 * `config/email.js` boundary (forcing `isEmailConfigured` true) so we can
 * inspect the actual rendered HTML — the thing that matters here is that the
 * tracking button is present when `trackingUrl` is defined and ENTIRELY absent
 * (no dead "#" link) when it isn't, mirroring the `buildTrackingUrl` fix for
 * `Carrier.Other`.
 */

const sendMailMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../src/config/email.js", () => ({
  isEmailConfigured: () => true,
  getTransporter: () => ({ sendMail: sendMailMock }),
}));

import { emailService } from "../../src/services/email.service.js";

describe("emailService.sendShippedEmail", () => {
  beforeEach(() => {
    sendMailMock.mockClear();
  });

  it("renders the carrier, tracking number, and a tracking button when trackingUrl is provided", async () => {
    await emailService.sendShippedEmail("cliente@test.com", {
      orderNumber: "MM-ABC123456789",
      carrier: Carrier.Dhl,
      trackingNumber: "TRACK-1",
      trackingUrl: "https://www.dhl.com/en/express/tracking.html?AWB=TRACK-1",
    });

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const call = sendMailMock.mock.calls[0]![0] as { to: string; subject: string; html: string };
    expect(call.to).toBe("cliente@test.com");
    expect(call.subject).toContain("MM-ABC123456789");
    expect(call.html).toContain("DHL");
    expect(call.html).toContain("TRACK-1");
    expect(call.html).toContain(
      `href="https://www.dhl.com/en/express/tracking.html?AWB=TRACK-1"`,
    );
  });

  it("omits the button/link entirely (no dead '#' link) when trackingUrl is undefined", async () => {
    await emailService.sendShippedEmail("cliente@test.com", {
      orderNumber: "MM-XYZ999999999",
      carrier: Carrier.Other,
      trackingNumber: "TRACK-2",
    });

    const call = sendMailMock.mock.calls[0]![0] as { html: string };
    expect(call.html).toContain("OTHER");
    expect(call.html).toContain("TRACK-2");
    expect(call.html).not.toContain("href=");
    expect(call.html).not.toContain('href="#"');
  });
});
