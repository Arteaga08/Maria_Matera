/**
 * Payment provider adapter DTOs shared by API and web. Kept provider-agnostic
 * so Stripe/MercadoPago adapters can implement the same shape.
 */

import type { PaymentProvider, PaymentStatus } from "../enums.js";

interface PaymentIntentResult {
  provider: PaymentProvider;
  ref: string;
  clientSecret?: string;
  status: PaymentStatus;
}

export type { PaymentIntentResult };
