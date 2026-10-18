/**
 * Builds what the agent "knows" on every turn: the trip, members' preferences, the live
 * itinerary with per-person costs, and the shared cross-channel conversation history.
 */
import type OpenAI from "openai";
import { participantsFor, splitEvenly } from "../commerce/splits";
import { prisma } from "../db";
import { formatUsd, parseJsonArray } from "../domain/types";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export async function loadTripSnapshot(tripId: string) {
  return prisma.trip.findUniqueOrThrow({
    where: { id: tripId },
    include: {
      members: { include: { user: true } },
      items: { where: { status: { notIn: ["REMOVED", "CANCELLED"] } }, orderBy: [{ dayIndex: "asc" }, { createdAt: "asc" }] },
    },
  });
}
export type TripSnapshot = Awaited<ReturnType<typeof loadTripSnapshot>>;

export interface MemberCost {
  userId: string;
  name: string;
  totalCents: number;
  budgetCents: number | null;
  overBudgetByCents: number;
}

/** Real-time per-person totals. Recomputed from scratch after every itinerary change. */
export function computeCostBreakdown(trip: TripSnapshot): MemberCost[] {
  const memberIds = trip.members.map((m) => m.userId);
  const totals = new Map(memberIds.map((id) => [id, 0]));

  for (const item of trip.items) {
    const participants = participantsFor(memberIds, parseJsonArray(item.optOutUserIds));
    for (const [userId, share] of splitEvenly(item.priceCents, participants)) {
      totals.set(userId, (totals.get(userId) ?? 0) + share);
    }
  }

  return trip.members.map((m) => {
    const totalCents = totals.get(m.userId) ?? 0;
    return {
      userId: m.userId,
      name: m.user.name,
      totalCents,
      budgetCents: m.budgetCents,
      overBudgetByCents: m.budgetCents === null ? 0 : Math.max(0, totalCents - m.budgetCents),
    };
  });
}

export function renderTripContext(trip: TripSnapshot): string {
  const nameOf = new Map(trip.members.map((m) => [m.userId, m.user.name]));
  const memberIds = trip.members.map((m) => m.userId);

  const members = trip.members.map((m) => {
    const likes = parseJsonArray(m.likes).join(", ") || "—";
    const dislikes = parseJsonArray(m.dislikes).join(", ") || "—";
    const budget = m.budgetCents === null ? "no budget set" : `budget ${formatUsd(m.budgetCents)}`;
    return `- ${m.user.name} (id ${m.userId}) | ${budget} | prefers ${m.user.preferredChannel} | likes: ${likes} | dislikes: ${dislikes}`;
  });

  const items = trip.items.length
    ? trip.items.map((i) => {
        const who = participantsFor(memberIds, parseJsonArray(i.optOutUserIds)).map((id) => nameOf.get(id)).join(", ");
        return `- [${i.id}] Day ${i.dayIndex} · ${i.category} · ${i.title} — ${formatUsd(i.priceCents)} total · ${i.status} · participants: ${who}`;
      })
    : ["- (empty — propose a plan from the catalog)"];

  const costs = computeCostBreakdown(trip).map(
    (c) =>
      `- ${c.name}: ${formatUsd(c.totalCents)}` +
      (c.budgetCents === null ? "" : ` of ${formatUsd(c.budgetCents)}`) +
      (c.overBudgetByCents > 0 ? ` ⚠️ OVER by ${formatUsd(c.overBudgetByCents)}` : ""),
  );

  return [
    `TRIP: ${trip.name} → ${trip.destination}, ${trip.startDate.toDateString()} – ${trip.endDate.toDateString()} (${trip.status})`,
    "MEMBERS:", ...members,
    "ITINERARY (prices are totals, split evenly among participants):", ...items,
    "COST PER PERSON:", ...costs,
  ].join("\n");
}

/**
 * The shared thread for the whole trip, across ALL channels. Each line is tagged with who
 * said it and on which channel, so the model can follow "Ana on WhatsApp" → "Ana on a call".
 */
export async function loadConversationHistory(tripId: string, limit: number): Promise<ChatMessage[]> {
  const rows = await prisma.message.findMany({
    where: { tripId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { user: true },
  });

  return rows.reverse().map((m): ChatMessage =>
    m.direction === "INBOUND"
      ? { role: "user", content: `[${m.user?.name ?? "Unknown"} via ${m.channel}]: ${m.body}` }
      : { role: "assistant", content: `(to ${m.user?.name ?? "group"} via ${m.channel}) ${m.body}` },
  );
}
