/**
 * Shared domain enums (single source of truth for API and web).
 * Values are stored verbatim in MongoDB, so do not rename without a migration.
 */

const ProductCategory = {
  Bracelets: "bracelets",
  Rings: "rings",
  Necklaces: "necklaces",
  Earrings: "earrings",
  BabyGold: "baby_gold",
} as const;
type ProductCategory = (typeof ProductCategory)[keyof typeof ProductCategory];

const OrderStatus = {
  PendingPayment: "pending_payment",
  Paid: "paid",
  Processing: "processing",
  Shipped: "shipped",
  Delivered: "delivered",
  Cancelled: "cancelled",
  Refunded: "refunded",
} as const;
type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

const PaymentProvider = {
  Stripe: "stripe",
  MercadoPago: "mercadopago",
} as const;
type PaymentProvider = (typeof PaymentProvider)[keyof typeof PaymentProvider];

const PaymentStatus = {
  Pending: "pending",
  Paid: "paid",
  Failed: "failed",
  Refunded: "refunded",
} as const;
type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

const ReservationStatus = {
  Active: "active",
  Committed: "committed",
  Released: "released",
  Expired: "expired",
} as const;
type ReservationStatus = (typeof ReservationStatus)[keyof typeof ReservationStatus];

const CustomerTier = {
  Standard: "standard",
  Vip: "vip",
} as const;
type CustomerTier = (typeof CustomerTier)[keyof typeof CustomerTier];

const AdminRole = {
  Admin: "admin",
  Editor: "editor",
} as const;
type AdminRole = (typeof AdminRole)[keyof typeof AdminRole];

const Currency = {
  Mxn: "MXN",
  Usd: "USD",
} as const;
type Currency = (typeof Currency)[keyof typeof Currency];

const UserType = {
  Customer: "customer",
  Admin: "admin",
} as const;
type UserType = (typeof UserType)[keyof typeof UserType];

const TokenType = {
  VerifyEmail: "verify_email",
  ResetPassword: "reset_password",
} as const;
type TokenType = (typeof TokenType)[keyof typeof TokenType];

export {
  ProductCategory,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  ReservationStatus,
  CustomerTier,
  AdminRole,
  Currency,
  UserType,
  TokenType,
};
