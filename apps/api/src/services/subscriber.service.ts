import { SubscriberStatus, UserType } from "@maria-matera/shared";
import { env } from "../config/env.js";
import { Subscriber } from "../models/Subscriber.js";
import type { CouponDocument } from "../models/Coupon.js";
import { AppError } from "../utils/AppError.js";
import { hashToken, randomToken } from "../utils/token.js";
import type { Actor } from "../utils/actor.js";
import { emailService } from "./email.service.js";
import { recordAudit } from "./audit.service.js";
import { adminGet as getCoupon } from "./coupon.service.js";

/**
 * Newsletter marketing: double opt-in subscription, one-click unsubscribe, and
 * sending a coupon to confirmed subscribers. Sending is sequential internally;
 * the controller (Milestone 9) fires this off fire-and-forget so the admin
 * request doesn't block on however many subscribers are on the list — a real
 * background queue is introduced in Paso 4.
 */

const MODULE = "Marketing";

const subscribe = async (email: string, consent?: boolean): Promise<void> => {
  const existing = await Subscriber.findOne({ email }).select("+unsubscribeToken");
  if (existing && existing.status === SubscriberStatus.Subscribed) {
    return; // already subscribed — nothing to do
  }

  const confirmRaw = randomToken();
  const subscriber = existing ?? new Subscriber({ email, unsubscribeToken: randomToken() });
  subscriber.status = SubscriberStatus.Pending;
  subscriber.consent = consent ?? false;
  subscriber.confirmTokenHash = hashToken(confirmRaw);
  await subscriber.save();

  const confirmUrl = `${env.appUrl}/newsletter/confirmar?token=${confirmRaw}`;
  await emailService.sendSubscriptionConfirmation(email, confirmUrl);
};

const confirm = async (rawToken: string): Promise<void> => {
  const subscriber = await Subscriber.findOne({ confirmTokenHash: hashToken(rawToken) }).select(
    "+confirmTokenHash",
  );
  if (!subscriber) {
    throw new AppError("El enlace de confirmación es inválido o ya se usó.", 400);
  }
  subscriber.status = SubscriberStatus.Subscribed;
  subscriber.confirmTokenHash = undefined;
  await subscriber.save();
};

const unsubscribe = async (rawToken: string): Promise<void> => {
  const subscriber = await Subscriber.findOne({ unsubscribeToken: rawToken }).select(
    "+unsubscribeToken",
  );
  if (!subscriber) {
    throw new AppError("El enlace de baja es inválido.", 400);
  }
  subscriber.status = SubscriberStatus.Unsubscribed;
  await subscriber.save();
};

/**
 * Fetches the coupon to broadcast. Split out from `broadcastCoupon` so the
 * controller can validate the `couponId` — and 404 immediately on a bad one —
 * BEFORE acknowledging the request, while the actual mass-send (below) still
 * runs fire-and-forget in the background.
 */
const getCouponForBroadcast = (couponId: string): Promise<CouponDocument> => getCoupon(couponId);

const broadcastCoupon = async (
  coupon: CouponDocument,
  actor: Actor,
): Promise<{ sent: number }> => {
  const subscribers = await Subscriber.find({ status: SubscriberStatus.Subscribed }).select(
    "+unsubscribeToken",
  );

  let sent = 0;
  for (const subscriber of subscribers) {
    const unsubscribeUrl = `${env.appUrl}/newsletter/baja?token=${subscriber.unsubscribeToken}`;
    await emailService.sendCouponEmail(
      subscriber.email,
      {
        code: coupon.code,
        description: coupon.description ?? `Aprovecha el cupón ${coupon.code} en Maria Matera.`,
      },
      unsubscribeUrl,
    );
    sent += 1;
  }

  await recordAudit({
    actorId: actor.id,
    actorType: UserType.Admin,
    action: "BROADCAST_COUPON",
    module: MODULE,
    targetId: coupon.id as string,
    after: { sent },
    ip: actor.ip,
  });

  return { sent };
};

export { subscribe, confirm, unsubscribe, getCouponForBroadcast, broadcastCoupon };
