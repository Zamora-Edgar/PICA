/**
 * VISA WALLET & TRUST CENTER read model: for each member, the agent credential's status, the
 * rules PICA must obey, every payment decision with its consent evidence, receipts, rewards,
 * and approvals still waiting on them.
 *
 * Approval codes are deliberately NOT included. They are a second factor sent to the member's
 * own channel, so they never appear on a shared screen.
 */
import { prisma } from "../db";
import { policyFromRecord } from "./trustLayer";
import { tierFor } from "./rewards";

const maskToken = (ref: string) => `agt_••••${ref.slice(-4)}`;

export async function buildWallet(tripId: string) {
  const trip = await prisma.trip.findUniqueOrThrow({
    where: { id: tripId },
    include: { members: { include: { user: { include: { spendingRule: true } } } } },
  });
  const userIds = trip.members.map((m) => m.userId);

  const [splits, lifetime, approvals] = await Promise.all([
    prisma.expenseSplit.findMany({
      where: { userId: { in: userIds }, item: { tripId } },
      include: { item: true },
      orderBy: { createdAt: "desc" },
    }),
    // Loyalty is lifetime (all trips), not per trip.
    prisma.expenseSplit.groupBy({
      by: ["userId"],
      where: { userId: { in: userIds }, status: "CAPTURED" },
      _sum: { rewardPoints: true, cashbackCents: true },
    }),
    prisma.approvalRequest.findMany({
      where: { userId: { in: userIds }, status: "PENDING", split: { item: { tripId } } },
      include: { split: { include: { item: true } } },
    }),
  ]);

  const members = trip.members.map((m) => {
    const mine = splits.filter((s) => s.userId === m.userId);
    const totals = lifetime.find((l) => l.userId === m.userId)?._sum;
    const points = totals?.rewardPoints ?? 0;
    return {
      userId: m.userId,
      name: m.user.name,
      channel: m.user.preferredChannel,
      token: m.user.visaAgentTokenRef
        ? { linked: true, display: maskToken(m.user.visaAgentTokenRef) }
        : { linked: false, display: "Not linked" },
      policy: policyFromRecord(m.user.spendingRule),
      rewards: {
        points,
        cashbackCents: totals?.cashbackCents ?? 0,
        ...tierFor(points),
      },
      spentCents: mine.filter((s) => s.status === "CAPTURED").reduce((sum, s) => sum + s.amountCents, 0),
      refundedCents: mine.filter((s) => s.status === "REFUNDED").reduce((sum, s) => sum + s.amountCents, 0),
      pendingApprovals: approvals
        .filter((a) => a.userId === m.userId)
        .map((a) => ({ approvalId: a.id, item: a.split.item.title, amountCents: a.split.amountCents, expiresAt: a.expiresAt, channel: a.channel })),
    };
  });

  // Audit trail: every decision the trust layer made on this trip, newest first.
  const nameOf = new Map(trip.members.map((m) => [m.userId, m.user.name]));
  const audit = splits.map((s) => ({
    splitId: s.id,
    member: nameOf.get(s.userId) ?? "?",
    item: s.item.title,
    merchant: s.item.merchantName,
    amountCents: s.amountCents,
    decision: s.decision,
    detail: s.decisionDetail,
    status: s.status,
    consentType: s.consentType,
    checks: parseRuleChecks(s.ruleChecks),
    visaAuthorizationId: s.visaAuthorizationId,
    rewardPoints: s.status === "CAPTURED" ? s.rewardPoints : 0,
    cashbackCents: s.status === "CAPTURED" ? s.cashbackCents : 0,
    at: s.capturedAt ?? s.authorizedAt ?? s.createdAt,
    refundedAt: s.refundedAt,
  }));

  return { members, audit };
}

function parseRuleChecks(json: string): { name: string; passed: boolean }[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
