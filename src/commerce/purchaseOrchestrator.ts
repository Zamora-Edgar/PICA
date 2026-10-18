/**
 * Purchase orchestration: turns "book the hotel" into per-person, rule-checked Visa payments.
 *
 *   initiatePurchase ─► split cost ─► trustLayer.evaluatePurchase (per member)
 *        │                                   │
 *        │      AUTO_PURCHASE ───────────────┼──► visa.authorizePayment (hold)
 *        │      REQUIRE_APPROVAL ────────────┼──► ApprovalRequest + Photon message
 *        │      DECLINE (anyone) ────────────┴──► abort item, nobody is charged
 *        ▼
 *   tryHandleApprovalReply ("YES 4821" on any channel) ──► authorize ──► finalizeItemIfComplete
 *                                                                          │
 *                                      all AUTHORIZED ─► capture all ─► PURCHASED
 *                                      any DECLINED   ─► void all holds ─► back to PROPOSED
 *
 *   capture also records each member's loyalty rewards (points + Visa offer cash back) and
 *   sends them a receipt; cancelBooking refunds every captured share (post-purchase).
 */
import { randomInt } from "node:crypto";
import { config } from "../config";
import { prisma } from "../db";
import { formatUsd, parseJsonArray, type ItemCategory } from "../domain/types";
import * as visa from "../integrations/visa";
import { notifyTrip, notifyUser } from "../notifications";
import { quoteReward } from "./rewards";
import { participantsFor, splitEvenly } from "./splits";
import { evaluatePurchase, policyFromRecord, type PurchaseDecision } from "./trustLayer";

export interface PurchaseSummary {
  itemId: string;
  title: string;
  outcome: "IN_PROGRESS" | "ABORTED";
  shares: { name: string; amountCents: number; action: PurchaseDecision["action"]; detail: string }[];
}

const COMMITTED = ["AUTHORIZED", "CAPTURED"];

export async function initiatePurchase(tripId: string, itemIds: string[]): Promise<PurchaseSummary[]> {
  const items = await prisma.itineraryItem.findMany({ where: { id: { in: itemIds }, tripId, status: "PROPOSED" } });
  const members = await prisma.tripMember.findMany({
    where: { tripId },
    include: { user: { include: { spendingRule: true } } },
  });
  const summaries: PurchaseSummary[] = [];

  for (const item of items) {
    // Lock the item so two concurrent "book it!" messages can't double-purchase.
    const locked = await prisma.itineraryItem.updateMany({
      where: { id: item.id, status: "PROPOSED" },
      data: { status: "PURCHASING" },
    });
    if (locked.count === 0) continue;
    await prisma.expenseSplit.deleteMany({ where: { itemId: item.id } }); // clear a previous aborted attempt

    const participants = participantsFor(members.map((m) => m.userId), parseJsonArray(item.optOutUserIds));
    const shares = [...splitEvenly(item.priceCents, participants)].filter(([, cents]) => cents > 0);

    // Pass 1 — evaluate every member against their own rules before any money moves.
    const evaluated = [];
    for (const [userId, amountCents] of shares) {
      const member = members.find((m) => m.userId === userId)!;
      const spend = await getSpendTotals(userId, tripId);
      const decision = evaluatePurchase(
        { amountCents, category: item.category as ItemCategory, merchantName: item.merchantName },
        policyFromRecord(member.user.spendingRule),
        { hasAgentToken: !!member.user.visaAgentTokenRef, tripBudgetCents: member.budgetCents, ...spend },
      );
      evaluated.push({ member, amountCents, decision });
    }

    const summary: PurchaseSummary = {
      itemId: item.id,
      title: item.title,
      outcome: "IN_PROGRESS",
      shares: evaluated.map((e) => ({
        name: e.member.user.name,
        amountCents: e.amountCents,
        action: e.decision.action,
        detail: e.decision.summary,
      })),
    };
    summaries.push(summary);

    // Any hard decline → abort before charging anyone. The group decides what to do next.
    const blocked = evaluated.filter((e) => e.decision.action === "DECLINE");
    if (blocked.length > 0) {
      summary.outcome = "ABORTED";
      await prisma.itineraryItem.update({ where: { id: item.id }, data: { status: "PROPOSED" } });
      for (const e of blocked) {
        await notifyUser(
          e.member.userId,
          `I couldn't book your ${formatUsd(e.amountCents)} share of ${item.title}: ${e.decision.summary}`,
          tripId,
        );
      }
      continue;
    }

    // Pass 2 — route each share.
    for (const { member, amountCents, decision } of evaluated) {
      const split = await prisma.expenseSplit.create({
        data: {
          itemId: item.id,
          userId: member.userId,
          amountCents,
          status: "PENDING_APPROVAL",
          decision: decision.action,
          decisionDetail: decision.summary,
          ruleChecks: JSON.stringify(decision.checks.map((c) => ({ name: c.name, passed: c.passed }))),
        },
      });

      if (decision.action === "AUTO_PURCHASE") {
        await authorizeSplit(split.id, {
          type: "AUTO_RULE",
          ruleChecks: decision.checks.filter((c) => c.passed).map((c) => c.name),
        });
      } else {
        await requestApproval(split.id, member.userId, member.user.preferredChannel, item.title, amountCents, decision, tripId);
      }
    }

    await finalizeItemIfComplete(item.id);
  }

  return summaries;
}

/** Human-in-the-loop: send an approval request over the user's preferred Photon channel. */
async function requestApproval(
  splitId: string,
  userId: string,
  channel: string,
  title: string,
  amountCents: number,
  decision: PurchaseDecision,
  tripId: string,
) {
  const code = String(randomInt(1000, 10000));
  await prisma.approvalRequest.create({
    data: {
      splitId,
      userId,
      code,
      channel,
      expiresAt: new Date(Date.now() + config.approvalTtlMinutes * 60_000),
    },
  });

  const spokenOrTyped = channel === "voice" ? `Say "yes ${code}" or "no ${code}".` : `Reply YES ${code} to approve or NO ${code} to skip.`;
  await notifyUser(
    userId,
    `💳 Approval needed: your share of ${title} is ${formatUsd(amountCents)}. ${decision.summary} ${spokenOrTyped} (Expires in ${config.approvalTtlMinutes} min.)`,
    tripId,
  );
}

/** Phase 1 of the Visa flow: hold this member's share on their agent token. */
async function authorizeSplit(splitId: string, consent: visa.ConsentEvidence): Promise<void> {
  const split = await prisma.expenseSplit.findUniqueOrThrow({
    where: { id: splitId },
    include: { user: true, item: true },
  });

  if (!split.user.visaAgentTokenRef) {
    await prisma.expenseSplit.update({ where: { id: splitId }, data: { status: "FAILED", failureReason: "NO_AGENT_TOKEN" } });
    return;
  }

  const result = await visa.authorizePayment({
    agentTokenRef: split.user.visaAgentTokenRef,
    amountCents: split.amountCents,
    currency: split.item.currency,
    merchant: { name: split.item.merchantName, visaMerchantId: split.item.visaMerchantId },
    description: `PICA: ${split.item.title} (share for ${split.user.name})`,
    idempotencyKey: `split_${split.id}`,
    consent,
  });

  await prisma.expenseSplit.update({
    where: { id: splitId },
    data: result.approved
      ? { status: "AUTHORIZED", visaAuthorizationId: result.authorizationId, authorizedAt: new Date(), consentType: consent.type }
      : { status: "FAILED", failureReason: result.declineReason },
  });
}

/**
 * Phase 2: once nobody is pending, either capture every hold (all in) or void them all
 * (someone said no / a card declined). Runs exactly once per attempt thanks to the
 * PURCHASING → FINALIZING compare-and-set.
 */
export async function finalizeItemIfComplete(itemId: string): Promise<void> {
  const splits = await prisma.expenseSplit.findMany({ where: { itemId }, include: { user: true } });
  const failed = splits.filter((s) => s.status === "DECLINED" || s.status === "FAILED");
  const pending = splits.filter((s) => s.status === "PENDING_APPROVAL");
  if (failed.length === 0 && pending.length > 0) return; // still waiting on humans

  const claimed = await prisma.itineraryItem.updateMany({
    where: { id: itemId, status: "PURCHASING" },
    data: { status: "FINALIZING" },
  });
  if (claimed.count === 0) return; // another request is already finalizing

  const item = await prisma.itineraryItem.findUniqueOrThrow({ where: { id: itemId } });

  if (failed.length > 0) {
    for (const s of splits) {
      if (s.status === "AUTHORIZED" && s.visaAuthorizationId) await visa.voidAuthorization(s.visaAuthorizationId);
      if (s.status === "AUTHORIZED" || s.status === "PENDING_APPROVAL") {
        await prisma.expenseSplit.update({ where: { id: s.id }, data: { status: "VOIDED" } });
      }
    }
    await prisma.approvalRequest.updateMany({
      where: { split: { itemId }, status: "PENDING" },
      data: { status: "EXPIRED" },
    });
    await prisma.itineraryItem.update({ where: { id: itemId }, data: { status: "PROPOSED" } });
    const names = failed.map((s) => s.user.name).join(", ");
    await notifyTrip(
      item.tripId,
      `Heads up: ${item.title} wasn't booked — ${names} couldn't confirm. Nobody was charged; all holds were released. Want me to find an alternative?`,
    );
    return;
  }

  const offers = await visa.getMerchantOffers();
  const receipts = [];
  for (const s of splits) {
    await visa.capturePayment(s.visaAuthorizationId!, s.amountCents);
    const reward = quoteReward(s.amountCents, item.merchantName, offers);
    await prisma.expenseSplit.update({
      where: { id: s.id },
      data: {
        status: "CAPTURED",
        capturedAt: new Date(),
        visaOfferId: reward.offer?.id ?? null,
        cashbackCents: reward.cashbackCents,
        rewardPoints: reward.points,
      },
    });
    receipts.push({ split: s, reward });
  }
  await prisma.itineraryItem.update({ where: { id: itemId }, data: { status: "PURCHASED" } });

  // Post-purchase: each member gets their own receipt with what they earned.
  const breakdown = splits.map((s) => `${s.user.name} ${formatUsd(s.amountCents)}`).join(", ");
  for (const { split, reward } of receipts) {
    const cashback = reward.cashbackCents > 0 ? ` + ${formatUsd(reward.cashbackCents)} back (${reward.offer!.headline})` : "";
    await notifyUser(
      split.userId,
      `✅ Booked ${item.title} (${formatUsd(item.priceCents)}). Split: ${breakdown}.\n` +
        `🧾 Your receipt: ${formatUsd(split.amountCents)} charged · +${reward.points} PICA points${cashback}. ` +
        "Free cancellation until 48h before the trip, just ask me.",
      item.tripId,
    );
  }
}

/** Free cancellation until this long before the trip starts. */
const CANCELLATION_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Post-purchase: cancel a booked item and refund every member's captured share to the card
 * it came from. Rewards earned on it are reversed (the REFUNDED status drops them from totals).
 */
export async function cancelBooking(tripId: string, itemId: string): Promise<{ ok: true; refunds: { name: string; amountCents: number }[] } | { ok: false; reason: string }> {
  const item = await prisma.itineraryItem.findFirst({
    where: { id: itemId, tripId },
    include: { trip: true, splits: { include: { user: true } } },
  });
  if (!item || item.status !== "PURCHASED") return { ok: false, reason: "Only booked items can be cancelled." };
  if (item.trip.startDate.getTime() - Date.now() < CANCELLATION_WINDOW_MS) {
    return { ok: false, reason: "The free-cancellation window (48h before the trip) has passed." };
  }

  // Claim the item first so a double "cancel" can't refund twice.
  const claimed = await prisma.itineraryItem.updateMany({ where: { id: itemId, status: "PURCHASED" }, data: { status: "CANCELLED" } });
  if (claimed.count === 0) return { ok: false, reason: "That booking is already being cancelled." };

  const refunds = [];
  for (const s of item.splits.filter((s) => s.status === "CAPTURED" && s.visaAuthorizationId)) {
    await visa.refundPayment(s.visaAuthorizationId!, s.amountCents, "GROUP_CANCELLED");
    await prisma.expenseSplit.update({ where: { id: s.id }, data: { status: "REFUNDED", refundedAt: new Date() } });
    refunds.push({ name: s.user.name, amountCents: s.amountCents });
  }
  await notifyTrip(
    tripId,
    `↩️ Cancelled ${item.title}. Refunds on the way to each card: ${refunds.map((r) => `${r.name} ${formatUsd(r.amountCents)}`).join(", ")}. Points from it were reversed.`,
  );
  return { ok: true, refunds };
}

// "YES 4821", "no 4821", "Yes, 4821." (voice transcript) or a bare "yes" — the WHOLE message
// must match, so a casual "yes that sounds fun" never approves a payment.
const APPROVAL_REPLY = /^\s*(yes|y|approve|no|n|decline)[\s,]*(\d{4})?\s*[.!]*\s*$/i;

/**
 * Deterministic approval handling. This deliberately does NOT go through the LLM: a
 * language model must never be the thing that decides a payment was approved.
 * Works on any channel — approve by WhatsApp a request that was sent by iMessage, or by voice.
 */
export async function tryHandleApprovalReply(
  userId: string,
  text: string,
): Promise<{ handled: false } | { handled: true; reply: string }> {
  const match = text.match(APPROVAL_REPLY);
  if (!match) return { handled: false };
  const approve = /^(yes|y|approve)$/i.test(match[1]);
  const code = match[2];

  const pending = await prisma.approvalRequest.findMany({
    where: { userId, status: "PENDING", ...(code ? { code } : {}) },
    include: { split: { include: { item: true, user: { include: { spendingRule: true } } } } },
  });
  if (pending.length === 0) {
    return code ? { handled: true, reply: `I couldn't find a pending approval with code ${code}.` } : { handled: false };
  }
  if (pending.length > 1) {
    const list = pending.map((p) => `${p.split.item.title} (${formatUsd(p.split.amountCents)}) → ${p.code}`).join("; ");
    return { handled: true, reply: `You have ${pending.length} approvals waiting. Reply YES or NO with the code: ${list}` };
  }

  const approval = pending[0];
  const { split } = approval;

  if (approval.expiresAt < new Date()) {
    await prisma.approvalRequest.update({ where: { id: approval.id }, data: { status: "EXPIRED" } });
    await prisma.expenseSplit.update({ where: { id: split.id }, data: { status: "DECLINED" } });
    await finalizeItemIfComplete(split.itemId);
    return { handled: true, reply: `That approval for ${split.item.title} expired, so I released everyone's holds. Ask me to book it again anytime.` };
  }

  // Claim the approval exactly once (protects against duplicate webhooks / double taps).
  const claimed = await prisma.approvalRequest.updateMany({
    where: { id: approval.id, status: "PENDING" },
    data: { status: approve ? "APPROVED" : "DECLINED", respondedAt: new Date() },
  });
  if (claimed.count === 0) return { handled: true, reply: "That one's already been handled 👍" };

  if (!approve) {
    await prisma.expenseSplit.update({ where: { id: split.id }, data: { status: "DECLINED" } });
    await finalizeItemIfComplete(split.itemId);
    return { handled: true, reply: `Got it — skipped ${split.item.title}. You won't be charged.` };
  }

  // Approval overrides soft limits only. Re-check hard limits now: spend may have changed
  // since the request went out, or the user may have unlinked their card.
  const recheck = evaluatePurchase(
    { amountCents: split.amountCents, category: split.item.category as ItemCategory, merchantName: split.item.merchantName },
    policyFromRecord(split.user.spendingRule),
    {
      hasAgentToken: !!split.user.visaAgentTokenRef,
      tripBudgetCents: null,
      ...(await getSpendTotals(userId, split.item.tripId)),
    },
  );
  if (recheck.action === "DECLINE") {
    await prisma.expenseSplit.update({ where: { id: split.id }, data: { status: "DECLINED", failureReason: recheck.summary } });
    await finalizeItemIfComplete(split.itemId);
    return { handled: true, reply: `I can't complete that even with your approval: ${recheck.summary}` };
  }

  await authorizeSplit(split.id, { type: "HUMAN_APPROVAL", approvalId: approval.id, ruleChecks: [] });
  await finalizeItemIfComplete(split.itemId);

  const after = await prisma.expenseSplit.findUniqueOrThrow({ where: { id: split.id }, include: { item: true } });
  if (after.status === "FAILED") {
    return { handled: true, reply: `Your card declined the ${formatUsd(split.amountCents)} charge for ${split.item.title} (${after.failureReason}).` };
  }
  const tail = after.item.status === "PURCHASED" ? "You were the last one — it's booked! 🎉" : "I'll confirm once the whole group is in.";
  return { handled: true, reply: `Approved ✅ ${formatUsd(split.amountCents)} for ${split.item.title}. ${tail}` };
}

/** Money already committed (held or settled) — feeds the budget and daily-limit checks. */
export async function getSpendTotals(userId: string, tripId: string) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [trip, today] = await Promise.all([
    prisma.expenseSplit.aggregate({
      _sum: { amountCents: true },
      where: { userId, status: { in: COMMITTED }, item: { tripId } },
    }),
    prisma.expenseSplit.aggregate({
      _sum: { amountCents: true },
      where: { userId, status: { in: COMMITTED }, authorizedAt: { gte: startOfDay } },
    }),
  ]);
  return { spentOnTripCents: trip._sum.amountCents ?? 0, spentTodayCents: today._sum.amountCents ?? 0 };
}
