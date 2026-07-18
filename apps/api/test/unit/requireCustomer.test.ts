import { describe, expect, it, vi } from "vitest";
import { UserType } from "@maria-matera/shared";
import type { Request, Response } from "express";
import { requireCustomer } from "../../src/middlewares/requireCustomer.js";
import { AppError } from "../../src/utils/AppError.js";

describe("requireCustomer", () => {
  it("calls next with 401 AppError when req.auth is missing", () => {
    const req = {} as Request;
    const next = vi.fn();

    requireCustomer(req, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0]?.[0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe("No autenticado");
  });

  it("calls next with 403 AppError when principal is an admin", () => {
    const req = { auth: { id: "admin1", userType: UserType.Admin } } as Request;
    const next = vi.fn();

    requireCustomer(req, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0]?.[0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe("No tienes permiso para realizar esta acción");
  });

  it("calls next with no error when principal is a customer", () => {
    const req = { auth: { id: "cust1", userType: UserType.Customer } } as Request;
    const next = vi.fn();

    requireCustomer(req, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });
});
