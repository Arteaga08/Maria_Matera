import { Carrier } from "@maria-matera/shared";

/**
 * Server-side carrier → tracking-URL builder. No URL is ever stored on the
 * order — it is always derived here from `shipping.carrier` +
 * `shipping.trackingNumber` at read time, so a carrier's URL scheme can change
 * without a data migration.
 */
const TRACKING_URL_BUILDERS: Partial<Record<Carrier, (trackingNumber: string) => string>> = {
  [Carrier.Dhl]: (t) => `https://www.dhl.com/en/express/tracking.html?AWB=${encodeURIComponent(t)}`,
  [Carrier.FedEx]: (t) => `https://www.fedex.com/apps/fedextrack/?tracknumbers=${encodeURIComponent(t)}`,
  [Carrier.Estafeta]: (t) => `https://www.estafeta.com/Herramientas/Rastreo?waybill=${encodeURIComponent(t)}`,
  [Carrier.Ups]: (t) => `https://www.ups.com/track?tracknum=${encodeURIComponent(t)}`,
  // Carrier.Other intentionally has NO builder — no URL, not a dead "#" link.
  // (A reference e-commerce repo we audited had this exact bug: unconstrained
  // carrier text meant unmapped carriers got a dead tracking button. We avoid
  // that by returning `undefined` here and letting the caller omit the link.)
};

const buildTrackingUrl = (carrier: Carrier, trackingNumber: string): string | undefined =>
  TRACKING_URL_BUILDERS[carrier]?.(trackingNumber);

export { buildTrackingUrl };
