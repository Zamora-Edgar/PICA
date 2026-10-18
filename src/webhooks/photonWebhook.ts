/**
 * PHOTON 2.0 INBOUND WEBHOOK — the agent's front door for every channel.
 *
 *   Photon ──POST /webhooks/photon──► verify signature ─► ack 200 immediately
 *                                          │
 *                                          ▼ (async)
 *   resolve (channel, address) → User → active Trip      ← cross-channel identity
 *   save message to the trip's shared thread (idempotent on Photon event id)
 *   "YES 4821"?  → deterministic approval handler         ← Visa human-in-the-loop, no LLM
 *   otherwise    → LLM agent with tools                   ← itinerary edits / purchase requests
 *   reply on the SAME channel (text, or TTS into the live call) via Photon
 *   itinerary changed? → tell the rest of the group on their own preferred channels
 *
 * 🔌 PHOTON: point your Photon number/handle's webhook URL at  {PUBLIC_BASE_URL}/webhooks/photon
 *    for messaging AND voice-transcript events.
 */
import express, { Router } from "express";
import { Prisma } from "@prisma/client";
import { runAgent } from "../agent/agent";
import { tryHandleApprovalReply } from "../commerce/purchaseOrchestrator";
import { prisma } from "../db";
import { resolveActiveTrip, resolveUser } from "../identity";
import {
  parsePhotonEvent,
  sendMessage,
  verifyPhotonSignature,
  type PhotonInboundEvent,
} from "../integrations/photon";
import { broadcastItineraryUpdate, notifyTrip } from "../notifications";
import { executeTool } from "../agent/tools";

export const photonWebhookRouter = Router();

photonWebhookRouter.post(
  "/webhooks/photon",
  express.raw({ type: "application/json" }), // raw bytes are needed for the HMAC check
  (req, res) => {
    const rawBody = req.body as Buffer;
    if (!verifyPhotonSignature(rawBody, req.header("x-photon-signature"))) {
      return res.status(401).json({ error: "invalid signature" });
    }

    let event: PhotonInboundEvent | null = null;
    try {
      event = parsePhotonEvent(JSON.parse(rawBody.toString("utf8")));
    } catch {
      return res.status(400).json({ error: "invalid JSON" });
    }
    if (!event) return res.status(200).json({ ignored: true });

    // Ack fast so Photon doesn't time out and retry while the LLM thinks.
    // The reply goes out asynchronously through Photon's send API.
    res.status(200).json({ received: true });
    handleInboundMessage(event).catch((err) => console.error("Photon event failed:", event?.eventId, err));
  },
);

export async function handleInboundMessage(event: PhotonInboundEvent): Promise<void> {
  const reply = (text: string) => sendMessage({ channel: event.channel, to: event.from, text, callId: event.callId });

  // 1. Who is this? Same person on WhatsApp, iMessage or a voice call → same User.
  const user = await resolveUser(event.channel, event.from);
  if (!user) {
    await reply("Hi! I'm PICA 🌴 (Personal Itinerary Commerce Agent). I don't recognize this number yet — ask your trip organizer for an invite link to join.");
    return;
  }

  // 2. Which trip? The conversation lives on the trip, not the channel.
  const trip = await resolveActiveTrip(user.id);
  if (!trip) {
    await reply(`Hey ${user.name}! You're not in an active trip right now. Open an invite link to join one.`);
    return;
  }

  // 3. Save to the shared thread. The unique photonEventId makes Photon retries a no-op.
  try {
    await prisma.message.create({
      data: {
        tripId: trip.id,
        userId: user.id,
        channel: event.channel,
        direction: "INBOUND",
        body: event.text,
        photonEventId: event.eventId,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return; // duplicate delivery
    throw err;
  }

  // 4. Approval replies ("YES 4821") are handled by deterministic code, never by the LLM.
  const approval = await tryHandleApprovalReply(user.id, event.text);

  let replyText: string;
  let itineraryChanged = false;
  const lower = event.text.toLowerCase().trim();

  if (approval.handled) {
    replyText = approval.reply;
  } else if (lower === "help" || lower === "commands" || lower === "menu") {
    // Fast path: Help / Commands
    replyText = `🌴 PICA Commands Quick Guide:\n\n` +
      `• "Summary" → View full itinerary & group splits\n` +
      `• "Budget" → Check your spend vs budget cap\n` +
      `• "Adjust to my budget" → Auto-rebalance items to fit your budget\n` +
      `• "My budget is $300" → Update your budget limit\n` +
      `• "Remind everyone" → Alert group members to confirm\n` +
      `• "Make [item] cheaper" → Swap for an affordable option\n` +
      `• "Book [item]" → Trigger Visa trust layer purchase\n` +
      `• "Suggest something" → Personalized picks for the group, with reasons\n` +
      `• "Rewards" → Your points, tier & Visa offer cash back\n` +
      `• "Cancel [item]" → Cancel a booking & refund everyone`;
  } else if (lower === "summary" || lower === "itinerary" || lower === "plan" || lower === "show plan" || lower === "what's the plan" || lower === "what is the plan") {
    // Fast path: Instant structured summary
    const { loadTripSnapshot, computeCostBreakdown } = await import("../agent/tripContext");
    const { formatUsd } = await import("../domain/types");
    const snapshot = await loadTripSnapshot(trip.id);
    const costs = computeCostBreakdown(snapshot);
    const myCost = costs.find((c) => c.userId === user.id);
    const activeItems = snapshot.items.filter((i) => i.status !== "REMOVED");
    const itemsList = activeItems.map((it) => `• Day ${it.dayIndex}: ${it.title} (${formatUsd(it.priceCents)})`).join("\n");
    const splitsList = costs.map((c) => `• ${c.name}: ${formatUsd(c.totalCents)} / cap ${formatUsd(c.budgetCents || 0)}`).join("\n");

    replyText = `🌴 PICA Trip Summary: ${snapshot.name}\n` +
      `📍 ${snapshot.destination}\n\n` +
      `🗓️ Itinerary:\n${itemsList || "(No items)"}\n\n` +
      `💵 Your Share: ${formatUsd(myCost?.totalCents || 0)}\n\n` +
      `👥 Group Splits:\n${splitsList}\n\n` +
      `Text "YES" to confirm, or ask me to adjust anything!`;
  } else if (lower === "budget" || lower === "my budget" || lower === "costs" || lower === "my share" || lower === "cost breakdown") {
    // Fast path: Instant budget report
    const { loadTripSnapshot, computeCostBreakdown } = await import("../agent/tripContext");
    const { formatUsd } = await import("../domain/types");
    const snapshot = await loadTripSnapshot(trip.id);
    const costs = computeCostBreakdown(snapshot);
    const myCost = costs.find((c) => c.userId === user.id);
    const budgetCents = myCost?.budgetCents || 40000;
    const totalCents = myCost?.totalCents || 0;
    const diff = budgetCents - totalCents;
    const statusStr = diff >= 0 ? `✅ $${(diff / 100).toFixed(0)} under budget` : `⚠️ $${(Math.abs(diff) / 100).toFixed(0)} over budget`;

    replyText = `💳 PICA Budget Status for ${user.name}:\n\n` +
      `• Current Share: ${formatUsd(totalCents)}\n` +
      `• Budget Cap: ${formatUsd(budgetCents)}\n` +
      `• Status: ${statusStr}\n\n` +
      `Need it lower? Just text "adjust to my budget"!`;
  } else if (lower.includes("remind everyone") || lower.includes("alert everyone") || lower.includes("nudge everyone") || lower.startsWith("remind ") || lower.startsWith("alert ")) {
    // Fast path: Remind members
    const targetMatch = lower.match(/(?:remind|alert|nudge)\s+([a-zA-Z]+)/);
    const targetName = targetMatch && targetMatch[1] !== "everyone" && targetMatch[1] !== "all" ? targetMatch[1] : "all";
    const toolRes = await executeTool("remind_members", { memberName: targetName }, { tripId: trip.id, userId: user.id });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = toolRes.data as any;
    replyText = data.message || "Sent reminders to the group to confirm their shares!";
  } else if (lower.includes("adjust to my budget") || lower.includes("fit my budget") || lower.includes("adjust to budget") || lower.includes("make it fit") || lower.includes("budget is") || lower.includes("over budget")) {
    // Fast path: Adjust to budget with optional dollar amount extraction
    const dollarMatch = lower.match(/\$(\d+)/) || lower.match(/(\d+)\s*(?:dollars|bucks)/);
    const targetDollars = dollarMatch ? Number(dollarMatch[1]) : undefined;
    const toolRes = await executeTool("adjust_to_budget", {
      targetBudgetDollars: targetDollars,
      newMemberBudgetDollars: targetDollars,
    }, { tripId: trip.id, userId: user.id });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = toolRes.data as any;
    itineraryChanged = toolRes.itineraryChanged ?? true;
    replyText = `🌴 Adjusted the itinerary to fit your budget!\n\n` +
      `Changes:\n` + (data.changes ?? []).map((c: string) => `• ${c}`).join("\n") + `\n\n` +
      `💵 Your new share: ${data.newShare} (Budget: ${data.targetBudget})\n` +
      `New group splits: ${(data.allCosts ?? []).join(", ")}`;
  } else if (["rewards", "my rewards", "points", "my points", "receipts", "wallet"].includes(lower)) {
    // Fast path: loyalty & receipts
    const data = (await executeTool("get_rewards", {}, { tripId: trip.id, userId: user.id })).data as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    replyText = data.error ?? `🎁 PICA Rewards for ${user.name}\n\n` +
      `• ${data.points} points · ${data.tier} tier (${data.pointsToNextTier})\n` +
      `• Visa offer cash back: ${data.visaCashback}\n` +
      `• Booked on this trip: ${data.spentOnTrip}\n` +
      (data.pendingApprovals.length ? `• Waiting on you: ${data.pendingApprovals.join(", ")}` : `• Nothing waiting on your approval`);
  } else if (/^(suggest|recommend)/.test(lower) || lower.includes("what should we do")) {
    // Fast path: personalized recommendations
    const data = (await executeTool("recommend_options", {}, { tripId: trip.id, userId: user.id })).data as { title: string; perPerson: string; why: string[] }[];
    replyText = data.length
      ? `✨ Picks for your group:\n\n` +
        data.map((r, i) => `${i + 1}. ${r.title} (${r.perPerson}/person)\n   ${r.why.join(" · ")}`).join("\n\n") +
        `\n\nWant me to add one? Just say which.`
      : "Your plan already has everything I'd recommend 🙌";
  } else if (lower.startsWith("cancel ")) {
    // Fast path: cancel a booking by (part of) its name
    const words = lower.slice(7).split(/\s+/).filter((w) => w.length > 2 && w !== "the");
    const booked = await prisma.itineraryItem.findMany({ where: { tripId: trip.id, status: "PURCHASED" } });
    const match = booked.find((i) => words.some((w) => i.title.toLowerCase().includes(w)));
    if (!match) {
      replyText = booked.length
        ? `Which booking? Booked so far: ${booked.map((i) => i.title).join(", ")}.`
        : "Nothing is booked yet, so there's nothing to cancel.";
    } else {
      const data = (await executeTool("cancel_booking", { itemId: match.id }, { tripId: trip.id, userId: user.id })).data as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      replyText = data.ok ? `Done: ${match.title} is cancelled and everyone's refund is on its way.` : `I couldn't cancel it: ${data.reason}`;
    }
  } else {
    // 5. Everything else goes to the agent with the full cross-channel context.
    const result = await runAgent({
      tripId: trip.id,
      userId: user.id,
      userName: user.name,
      channel: event.channel,
      text: event.text,
    });
    replyText = result.reply;
    itineraryChanged = result.itineraryChanged;
  }

  // 6. Reply on the channel they used — text back for messaging, spoken into the call for voice.
  await reply(replyText);
  await prisma.message.create({
    data: { tripId: trip.id, userId: user.id, channel: event.channel, direction: "OUTBOUND", body: replyText },
  });

  // 7. Keep everyone else in sync with full updated itinerary on their preferred channel.
  if (itineraryChanged) {
    await broadcastItineraryUpdate(trip.id, user.id, replyText);
  }
}
