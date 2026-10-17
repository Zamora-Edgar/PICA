/**
 * AGENTIC COMMERCE TRUST LAYER
 *
 * Decides, for one member's share of one itinerary item, whether the agent may:
 *   AUTO_PURCHASE    — buy now; every rule passed
 *   REQUIRE_APPROVAL — ask the human over their preferred Photon channel first
 *   DECLINE          — not allowed at all, even with approval (hard limit)
 *
 * Design choices:
 *  - Pure function: no DB, no network, no LLM. Deterministic and unit-testable. The LLM can
 *    *request* a purchase, but only this code decides whether money moves.
 *  - Every check is evaluated (no short-circuit) so the user hears every reason at once.
 *  - Safe defaults: with no rule configured, autoApproveLimit is 0 → everything needs approval.
 *  - These same limits are mirrored onto the Visa agent token (visa.syncAgentControls), so the
 *    network enforces the hard caps independently.
 */
import type { SpendingRule } from "@prisma/client";
import { formatUsd, parseJsonArray, type ItemCategory } from "../domain/types";

export type PurchaseAction = "AUTO_PURCHASE" | "REQUIRE_APPROVAL" | "DECLINE";

export interface PurchaseCandidate {
  amountCents: number; // this member's share
  category: ItemCategory;
  merchantName: string;
}

export interface SpendingPolicy {
  autoApproveLimitCents: number;
  perTransactionMaxCents: number;
  dailyLimitCents: number | null;
  allowedCategories: string[]; // empty = all categories allowed
  blockedMerchants: string[];
  alwaysRequireApproval: boolean;
}

export interface SpendContext {
  hasAgentToken: boolean; // has the user linked a Visa card for agent payments?
  tripBudgetCents: number | null; // from the invite-link preferences
  spentOnTripCents: number; // already authorized/captured on this trip
  spentTodayCents: number; // already authorized/captured today, all trips
}

export interface RuleCheck {
  name: string;
  passed: boolean;
  onFail: "DECLINE" | "REQUIRE_APPROVAL";
  detail: string; // user-facing explanation, used when the check fails
}

export interface PurchaseDecision {
  action: PurchaseAction;
  checks: RuleCheck[];
  failed: RuleCheck[];
  summary: string;
}

export const DEFAULT_POLICY: SpendingPolicy = {
  autoApproveLimitCents: 0,
  perTransactionMaxCents: 100_000,
  dailyLimitCents: null,
  allowedCategories: [],
  blockedMerchants: [],
  alwaysRequireApproval: false,
};

export function evaluatePurchase(
  item: PurchaseCandidate,
  policy: SpendingPolicy,
  ctx: SpendContext,
): PurchaseDecision {
  const amount = item.amountCents;
  const merchant = item.merchantName.trim().toLowerCase();
  const tripTotalAfter = ctx.spentOnTripCents + amount;
  const dayTotalAfter = ctx.spentTodayCents + amount;

  const checks: RuleCheck[] = [
    // ── Hard limits: failing any of these means the agent may NOT spend, even with approval ──
    {
      name: "VALID_AMOUNT",
      passed: Number.isInteger(amount) && amount > 0,
      onFail: "DECLINE",
      detail: `The amount (${amount} cents) is invalid.`,
    },
    {
      name: "AGENT_TOKEN_LINKED",
      passed: ctx.hasAgentToken,
      onFail: "DECLINE",
      detail: "You haven't linked a Visa card for PICA payments yet.",
    },
    {
      name: "MERCHANT_NOT_BLOCKED",
      passed: !policy.blockedMerchants.some((b) => b.trim() && merchant.includes(b.trim().toLowerCase())),
      onFail: "DECLINE",
      detail: `${item.merchantName} is on your blocked-merchant list.`,
    },
    {
      name: "PER_TRANSACTION_MAX",
      passed: amount <= policy.perTransactionMaxCents,
      onFail: "DECLINE",
      detail: `${formatUsd(amount)} is over your hard per-purchase cap of ${formatUsd(policy.perTransactionMaxCents)}.`,
    },

    // ── Soft limits: failing these escalates to a human, who can still say yes ──
    {
      name: "CATEGORY_ALLOWED",
      passed: policy.allowedCategories.length === 0 || policy.allowedCategories.includes(item.category),
      onFail: "REQUIRE_APPROVAL",
      detail: `${item.category.toLowerCase()} isn't one of your auto-buy categories.`,
    },
    {
      name: "WITHIN_TRIP_BUDGET",
      passed: ctx.tripBudgetCents === null || tripTotalAfter <= ctx.tripBudgetCents,
      onFail: "REQUIRE_APPROVAL",
      detail: `This brings your trip total to ${formatUsd(tripTotalAfter)}, over your ${formatUsd(ctx.tripBudgetCents ?? 0)} budget.`,
    },
    {
      name: "WITHIN_DAILY_LIMIT",
      passed: policy.dailyLimitCents === null || dayTotalAfter <= policy.dailyLimitCents,
      onFail: "REQUIRE_APPROVAL",
      detail: `This brings today's spend to ${formatUsd(dayTotalAfter)}, over your ${formatUsd(policy.dailyLimitCents ?? 0)} daily limit.`,
    },
    {
      name: "UNDER_AUTO_BUY_LIMIT",
      passed: amount <= policy.autoApproveLimitCents,
      onFail: "REQUIRE_APPROVAL",
      detail: `${formatUsd(amount)} is above your auto-buy limit of ${formatUsd(policy.autoApproveLimitCents)}.`,
    },
    {
      name: "AUTO_BUY_ENABLED",
      passed: !policy.alwaysRequireApproval,
      onFail: "REQUIRE_APPROVAL",
      detail: "You've asked to approve every purchase yourself.",
    },
  ];

  const failed = checks.filter((c) => !c.passed);
  const hardFailures = failed.filter((c) => c.onFail === "DECLINE");

  const action: PurchaseAction =
    hardFailures.length > 0 ? "DECLINE" : failed.length > 0 ? "REQUIRE_APPROVAL" : "AUTO_PURCHASE";

  const summary =
    action === "AUTO_PURCHASE"
      ? `${formatUsd(amount)} is within all your rules, so I can buy it automatically.`
      : (action === "DECLINE" ? hardFailures : failed).map((c) => c.detail).join(" ");

  return { action, checks, failed, summary };
}

/** Convert the DB row (JSON-string columns) into a policy, falling back to safe defaults. */
export function policyFromRecord(rule: SpendingRule | null | undefined): SpendingPolicy {
  if (!rule) return DEFAULT_POLICY;
  return {
    autoApproveLimitCents: rule.autoApproveLimitCents,
    perTransactionMaxCents: rule.perTransactionMaxCents,
    dailyLimitCents: rule.dailyLimitCents,
    allowedCategories: parseJsonArray(rule.allowedCategories),
    blockedMerchants: parseJsonArray(rule.blockedMerchants),
    alwaysRequireApproval: rule.alwaysRequireApproval,
  };
}
