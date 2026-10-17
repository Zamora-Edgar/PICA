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
    await reply("Hi! I'm TripSync ✈️ I don't recognize this number yet — ask your trip organizer for an invite link to join.");
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
