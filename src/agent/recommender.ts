/**
 * PERSONALIZATION & DECISION SUPPORT — ranks catalog options for THIS group.
 *
 * Each option is scored on:
 *   + whose likes it matches (from the invite form)
 *   − whose dislikes it hits
 *   + how many members can afford their share with the budget they have left
 *   + a Visa card-linked offer on the merchant
 *
 * Every score comes with plain-language reasons, so the dashboard and the agent can say WHY
 * something was suggested. Deterministic: the LLM uses this ranking, it doesn't invent one.
 * Only likes, dislikes and budgets are used: no browsing history, no data from other trips.
 */
import { formatUsd, parseJsonArray, type ItemCategory } from "../domain/types";
import type { VisaOffer } from "../integrations/visa";
import { CATALOG, matchesDestination, type CatalogOption } from "./catalog";
import { quoteReward } from "../commerce/rewards";
import { computeCostBreakdown, type TripSnapshot } from "./tripContext";

export interface Recommendation {
  option: CatalogOption;
  score: number; // 0–100
  perPersonCents: number;
  fitsBudgetCount: number;
  matchedLikes: { member: string; like: string }[];
  dislikeHits: { member: string; dislike: string }[];
  offer: VisaOffer | null;
  pointsPerPerson: number;
  reasons: string[];
}

// Free-text likes → catalog vocabulary. Anything not listed is matched on its own stem.
const SYNONYMS: Record<string, string[]> = {
  photography: ["views", "sunset", "sightseeing", "wildlife"],
  "fine dining": ["seafood", "dinner"],
  "good food": ["food", "market", "seafood"],
  exploring: ["sightseeing", "history", "tour", "trolley"],
  music: ["social", "bonfire"],
  nature: ["wildlife", "beach", "sailing"],
  nightlife: ["social", "drinks", "craft beer"],
};

const stem = (word: string) => word.toLowerCase().trim().replace(/(ing|es|s)$/, "");

function termsFor(phrase: string): string[] {
  const key = phrase.toLowerCase().trim();
  return [...(SYNONYMS[key] ?? []), ...key.split(/\s+/).filter((w) => w.length > 2).map(stem)];
}

const matches = (option: CatalogOption, phrase: string) => {
  const haystack = `${option.title} ${option.description} ${option.tags.join(" ")}`.toLowerCase();
  return termsFor(phrase).some((t) => haystack.includes(t));
};

export function recommendForTrip(
  trip: TripSnapshot,
  offers: VisaOffer[],
  filter: { category?: ItemCategory; limit?: number } = {},
): Recommendation[] {
  const costs = computeCostBreakdown(trip);
  const memberCount = Math.max(1, trip.members.length);
  const inPlan = new Set(trip.items.map((i) => i.catalogOptionId));
  const overBudgetCount = costs.filter((c) => c.overBudgetByCents > 0).length;

  const ranked = CATALOG.filter(
    (o) =>
      matchesDestination(o.destination, trip.destination) &&
      !inPlan.has(o.id) &&
      (!filter.category || o.category === filter.category),
  ).map((option) => {
    const perPersonCents = Math.ceil(option.priceCents / memberCount);
    const matchedLikes: Recommendation["matchedLikes"] = [];
    const dislikeHits: Recommendation["dislikeHits"] = [];
    let fitsBudgetCount = 0;

    for (const m of trip.members) {
      for (const like of parseJsonArray(m.likes)) if (matches(option, like)) matchedLikes.push({ member: m.user.name, like });
      for (const dislike of parseJsonArray(m.dislikes)) if (matches(option, dislike)) dislikeHits.push({ member: m.user.name, dislike });
      const cost = costs.find((c) => c.userId === m.userId);
      const headroom = m.budgetCents === null ? Infinity : m.budgetCents - (cost?.totalCents ?? 0);
      if (perPersonCents <= headroom) fitsBudgetCount++;
    }

    const reward = quoteReward(perPersonCents, option.merchantName, offers);
    const likedBy = new Set(matchedLikes.map((l) => l.member)).size;

    const raw =
      40 * (likedBy / memberCount) +
      40 * (fitsBudgetCount / memberCount) +
      (reward.offer ? 10 : 0) +
      10 * (1 - Math.min(1, perPersonCents / 40_000)) - // mild preference for cheaper
      25 * new Set(dislikeHits.map((d) => d.member)).size;
    const score = Math.max(0, Math.min(100, Math.round(raw)));

    const reasons: string[] = [];
    if (matchedLikes.length) {
      const byMember = new Map<string, string[]>();
      for (const l of matchedLikes) byMember.set(l.member, [...(byMember.get(l.member) ?? []), l.like]);
      reasons.push(`Matches ${[...byMember].map(([n, ls]) => `${n}'s love of ${ls.join(" & ").toLowerCase()}`).join(", ")}`);
    }
    reasons.push(
      fitsBudgetCount === memberCount
        ? `Fits everyone's remaining budget at ${formatUsd(perPersonCents)}/person`
        : overBudgetCount === memberCount
          ? `Plan is already over budget for everyone. This adds ${formatUsd(perPersonCents)}/person`
          : `${formatUsd(perPersonCents)}/person fits ${fitsBudgetCount} of ${memberCount} remaining budgets`,
    );
    if (reward.offer) reasons.push(`Visa offer: ${reward.offer.headline}`);
    for (const d of dislikeHits) reasons.push(`⚠️ ${d.member} dislikes ${d.dislike.toLowerCase()}`);

    return { option, score, perPersonCents, fitsBudgetCount, matchedLikes, dislikeHits, offer: reward.offer, pointsPerPerson: reward.points, reasons };
  });

  return ranked.sort((a, b) => b.score - a.score || a.perPersonCents - b.perPersonCents).slice(0, filter.limit ?? 5);
}
