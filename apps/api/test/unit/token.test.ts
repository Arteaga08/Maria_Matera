import { describe, expect, it } from "vitest";
import { UserType } from "@maria-matera/shared";
import {
  generateAccessToken,
  hashToken,
  randomToken,
  verifyAccessToken,
} from "../../src/utils/token.js";

describe("token utils", () => {
  it("hashToken is deterministic and randomToken is unique", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(randomToken()).not.toBe(randomToken());
    expect(randomToken()).toHaveLength(64);
  });

  it("round-trips an access token payload", () => {
    const token = generateAccessToken({ sub: "123", userType: UserType.Customer });
    const payload = verifyAccessToken(token);
    expect(payload.sub).toBe("123");
    expect(payload.userType).toBe(UserType.Customer);
  });

  it("rejects a tampered token", () => {
    const token = generateAccessToken({ sub: "123", userType: UserType.Customer });
    expect(() => verifyAccessToken(`${token}tampered`)).toThrow();
  });
});
