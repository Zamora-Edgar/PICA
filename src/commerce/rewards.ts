/**
 * LOYALTY & REWARDS — what a member earns when their share settles.
 *
 *   base:   1 PICA point per $1 captured
 *   offer:  a Visa card-linked offer for the merchant adds cash back (statement credit)
 *           and multiplies the points
 *
 * Pure function so the dashboard can preview "you'll earn X" before booking, and capture
 * can record exactly the same numbers afterwards.
 */
import type { VisaOffer } from "../integrations/visa";

export interface RewardQuote {
  offer: VisaOffer | null;
  cashbackCents: number;
  points: number;
}

export const findOffer = (offers: VisaOffer[], merchantName: string) =>
  offers.find((o) => o.merchantName.toLowerCase() === merchantName.trim().toLowerCase()) ?? null;

export function quoteReward(amountCents: number, merchantName: string, offers: VisaOffer[]): RewardQuote {
  const offer = findOffer(offers, merchantName);
  const basePoints = Math.floor(amountCents / 100);
  if (!offer) return { offer: null, cashbackCents: 0, points: basePoints };
  return {
    offer,
    cashbackCents: Math.min(offer.maxCashbackCents, Math.round((amountCents * offer.cashbackPercent) / 100)),
    points: basePoints * offer.pointsMultiplier,
  };
}

/** Loyalty tiers on lifetime points. Shown to the member; no tier changes what the agent may spend. */
export const TIERS = [
  { name: "Explorer", minPoints: 0 },
  { name: "Voyager", minPoints: 250 },
  { name: "Globetrotter", minPoints: 750 },
] as const;

export function tierFor(points: number) {
  const index = TIERS.reduce((best, t, i) => (points >= t.minPoints ? i : best), 0);
  const next = TIERS[index + 1];
  return { tier: TIERS[index].name, nextTier: next?.name ?? null, pointsToNext: next ? next.minPoints - points : 0 };
}
