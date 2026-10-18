/**
 * REST API for the web dashboard: create a trip, join via invite link, link a Visa card,
 * and read the live itinerary + per-person costs.
 */
import { randomBytes } from "node:crypto";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { recommendForTrip } from "../agent/recommender";
import { computeCostBreakdown, loadTripSnapshot } from "../agent/tripContext";
import { cancelBooking, initiatePurchase } from "../commerce/purchaseOrchestrator";
import { policyFromRecord } from "../commerce/trustLayer";
import { buildWallet } from "../commerce/wallet";
import { config } from "../config";
import { prisma } from "../db";
import { ITEM_CATEGORIES } from "../domain/types";
import { linkDefaultIdentities, normalizeAddress } from "../identity";
import { CHANNELS, createInviteLink } from "../integrations/photon";
import { getMerchantOffers, revokeAgentToken, syncAgentControls } from "../integrations/visa";
import { notifyUser } from "../notifications";

export const apiRouter = Router();
apiRouter.use(express.json());

const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

const personSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(7),
  email: z.string().email().optional(),
  preferredChannel: z.enum(CHANNELS).default("sms"),
});

const spendingRuleSchema = z.object({
  autoApproveLimitCents: z.number().int().min(0),
  perTransactionMaxCents: z.number().int().positive(),
  dailyLimitCents: z.number().int().positive().nullable(),
  allowedCategories: z.array(z.enum(ITEM_CATEGORIES)),
  blockedMerchants: z.array(z.string()),
  alwaysRequireApproval: z.boolean(),
}).partial();

async function upsertPerson(p: z.infer<typeof personSchema>) {
  const phoneE164 = normalizeAddress(p.phone);
  const user = await prisma.user.upsert({
    where: { phoneE164 },
    create: { name: p.name, phoneE164, email: p.email, preferredChannel: p.preferredChannel },
    update: { name: p.name, email: p.email, preferredChannel: p.preferredChannel },
  });
  await linkDefaultIdentities(user.id, phoneE164, p.email);
  return user;
}

// 1. Onboarding: organizer creates a trip and gets a Photon invite link to share.
apiRouter.post("/trips", handle(async (req, res) => {
  const body = z.object({
    name: z.string().min(1),
    destination: z.string().min(1),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    organizer: personSchema.extend({ budgetCents: z.number().int().positive().optional() }),
  }).parse(req.body);

  const organizer = await upsertPerson(body.organizer);
  const trip = await prisma.trip.create({
    data: {
      name: body.name,
      destination: body.destination,
      startDate: body.startDate,
      endDate: body.endDate,
      inviteCode: randomBytes(6).toString("base64url"),
      organizerId: organizer.id,
      members: { create: { userId: organizer.id, role: "ORGANIZER", budgetCents: body.organizer.budgetCents } },
    },
  });

  const inviteUrl = await createInviteLink(trip); // 🔌 PHOTON link
  await prisma.trip.update({ where: { id: trip.id }, data: { inviteUrl } });
  await notifyUser(organizer.id, `Your trip "${trip.name}" is live! 🎉 Send this link to your friends: ${inviteUrl}`, trip.id);

  res.status(201).json({ tripId: trip.id, inviteUrl });
}));

// 2. Preference collection: friend opens the invite link and submits this form.
apiRouter.post("/invites/:code/join", handle(async (req, res) => {
  const body = personSchema.extend({
    budgetCents: z.number().int().positive().optional(),
    likes: z.array(z.string()).default([]),
    dislikes: z.array(z.string()).default([]),
    spendingRule: spendingRuleSchema.optional(),
  }).parse(req.body);

  const trip = await prisma.trip.findUnique({ where: { inviteCode: req.params.code } });
  if (!trip) return res.status(404).json({ error: "Invite not found" });

  const user = await upsertPerson(body);
  const prefs = { budgetCents: body.budgetCents, likes: JSON.stringify(body.likes), dislikes: JSON.stringify(body.dislikes) };
  await prisma.tripMember.upsert({
    where: { tripId_userId: { tripId: trip.id, userId: user.id } },
    create: { tripId: trip.id, userId: user.id, ...prefs },
    update: prefs,
  });

  if (body.spendingRule) {
    const { allowedCategories, blockedMerchants, ...rest } = body.spendingRule;
    const data = {
      ...rest,
      ...(allowedCategories && { allowedCategories: JSON.stringify(allowedCategories) }),
      ...(blockedMerchants && { blockedMerchants: JSON.stringify(blockedMerchants) }),
    };
    await prisma.spendingRule.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data });
  }

  const callLine = config.photon.voiceNumber ? ` or call ${config.photon.voiceNumber}` : "";
  await notifyUser(user.id, `Welcome to ${trip.name}, ${user.name}! I'm PICA 🌴 Text me here${callLine} anytime to shape the plan.`, trip.id);
  res.status(201).json({ userId: user.id, tripId: trip.id });
}));

// 3. Visa card linking. The card is enrolled in the browser with Visa's client-side flow —
//    the card number never reaches our server. We receive an agent token reference, store
//    it, and push the user's spending rules onto it so Visa enforces them too.
apiRouter.post("/users/:id/visa-token", handle(async (req, res) => {
  const { agentTokenRef } = z.object({ agentTokenRef: z.string().min(1) }).parse(req.body);
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { visaAgentTokenRef: agentTokenRef },
    include: { spendingRule: true },
  });
  const policy = policyFromRecord(user.spendingRule);
  await syncAgentControls(agentTokenRef, policy); // 🔌 VISA
  res.json({ linked: true });
}));

// Dashboard read model: itinerary + real-time per-person split.
apiRouter.get("/trips/:id", handle(async (req, res) => {
  const trip = await loadTripSnapshot(req.params.id);
  res.json({ trip, costs: computeCostBreakdown(trip) });
}));

// Quick access to latest active trip for dashboard
apiRouter.get("/active", handle(async (_req, res) => {
  const trip = await prisma.trip.findFirst({
    where: { status: { in: ["PLANNING", "BOOKING"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!trip) return res.status(404).json({ error: "No active trip found" });
  const snapshot = await loadTripSnapshot(trip.id);
  const messages = await prisma.message.findMany({
    where: { tripId: trip.id },
    orderBy: { createdAt: "desc" },
    take: 25,
    include: { user: true },
  });
  res.json({ trip: snapshot, costs: computeCostBreakdown(snapshot), messages, offers: await getMerchantOffers() });
}));

const activeTrip = () =>
  prisma.trip.findFirst({ where: { status: { in: ["PLANNING", "BOOKING"] } }, orderBy: { createdAt: "desc" } });

// ─── Visa shopping journey ───────────────────────────────────────────────────

// Discovery + personalization + decision support: ranked picks with the reasons behind them.
apiRouter.get("/active/recommendations", handle(async (req, res) => {
  const trip = await activeTrip();
  if (!trip) return res.status(404).json({ error: "No active trip" });
  const category = z.enum(ITEM_CATEGORIES).optional().parse(req.query.category || undefined);
  res.json(recommendForTrip(await loadTripSnapshot(trip.id), await getMerchantOffers(), { category, limit: 4 }));
}));

// Add a recommended option to the plan.
apiRouter.post("/active/items", handle(async (req, res) => {
  const trip = await activeTrip();
  if (!trip) return res.status(404).json({ error: "No active trip" });
  const { optionId, dayIndex } = z.object({ optionId: z.string(), dayIndex: z.number().int().min(1) }).parse(req.body);
  const { executeTool } = await import("../agent/tools");
  const { broadcastItineraryUpdate } = await import("../notifications");
  const result = await executeTool("add_item", { optionId, dayIndex }, { tripId: trip.id, userId: trip.organizerId });
  if (result.itineraryChanged) await broadcastItineraryUpdate(trip.id, trip.organizerId, `Added a recommended pick for day ${dayIndex}`);
  res.json(result.data);
}));

// Checkout: run an item through the trust layer → Visa (auto-buy or approval per member).
apiRouter.post("/active/book", handle(async (req, res) => {
  const trip = await activeTrip();
  if (!trip) return res.status(404).json({ error: "No active trip" });
  const { itemId } = z.object({ itemId: z.string() }).parse(req.body);
  res.json(await initiatePurchase(trip.id, [itemId]));
}));

// Post-purchase: cancel a booking and refund everyone.
apiRouter.post("/active/cancel", handle(async (req, res) => {
  const trip = await activeTrip();
  if (!trip) return res.status(404).json({ error: "No active trip" });
  const { itemId } = z.object({ itemId: z.string() }).parse(req.body);
  const result = await cancelBooking(trip.id, itemId);
  res.status(result.ok ? 200 : 409).json(result);
}));

// Wallet & Trust Center: tokens, rules, rewards, receipts, pending approvals, audit trail.
apiRouter.get("/active/wallet", handle(async (_req, res) => {
  const trip = await activeTrip();
  if (!trip) return res.status(404).json({ error: "No active trip" });
  res.json(await buildWallet(trip.id));
}));

// DEMO ONLY: stands in for the member replying "YES 1234" on their phone. The code is looked
// up here on the server and fed through the normal inbound pipeline, so the browser never
// sees it and the deterministic approval handler is the one that decides.
apiRouter.post("/active/approvals/:id/simulate-reply", handle(async (req, res) => {
  const { approve } = z.object({ approve: z.boolean() }).parse(req.body);
  const approval = await prisma.approvalRequest.findUnique({ where: { id: req.params.id }, include: { user: true } });
  if (!approval || approval.status !== "PENDING") return res.status(404).json({ error: "No pending approval" });
  const { handleInboundMessage } = await import("../webhooks/photonWebhook");
  await handleInboundMessage({
    eventId: `sim_${approval.id}_${Date.now()}`,
    channel: approval.channel as (typeof CHANNELS)[number],
    from: approval.user.phoneE164,
    to: config.photon.agentHandle,
    text: `${approve ? "YES" : "NO"} ${approval.code}`,
  });
  res.json({ ok: true });
}));

// Kill switch: revoke the member's agent credential at Visa. PICA can no longer charge them;
// every future purchase is hard-declined (AGENT_TOKEN_LINKED) until they re-link.
apiRouter.post("/users/:id/revoke-token", handle(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.visaAgentTokenRef) await revokeAgentToken(user.visaAgentTokenRef); // 🔌 VISA
  await prisma.user.update({ where: { id: user.id }, data: { visaAgentTokenRef: null } });
  await notifyUser(user.id, "🔒 Your Visa agent credential for PICA has been revoked. I can't charge your card until you link it again.");
  res.json({ revoked: true });
}));

// Dashboard Action: Nudge / Remind all members to confirm
apiRouter.post("/active/remind", handle(async (req, res) => {
  const trip = await prisma.trip.findFirst({ where: { status: { in: ["PLANNING", "BOOKING"] } }, orderBy: { createdAt: "desc" } });
  if (!trip) return res.status(404).json({ error: "No active trip" });
  const organizerId = trip.organizerId;
  const { executeTool } = await import("../agent/tools");
  const result = await executeTool("remind_members", { memberName: "all" }, { tripId: trip.id, userId: organizerId });
  res.json({ ok: true, result });
}));

// Dashboard Action: Auto-adjust to lowest budget
apiRouter.post("/active/adjust-budget", handle(async (req, res) => {
  const trip = await prisma.trip.findFirst({ where: { status: { in: ["PLANNING", "BOOKING"] } }, orderBy: { createdAt: "desc" } });
  if (!trip) return res.status(404).json({ error: "No active trip" });
  const organizerId = trip.organizerId;
  const { executeTool } = await import("../agent/tools");
  const { broadcastItineraryUpdate } = await import("../notifications");
  const result = await executeTool("adjust_to_budget", {}, { tripId: trip.id, userId: organizerId });
  if (result.itineraryChanged) {
    await broadcastItineraryUpdate(trip.id, organizerId, "Dashboard budget optimization");
  }
  res.json({ ok: true, result });
}));

// Dashboard Action: Send a message into the conversation thread (from web)
apiRouter.post("/active/message", handle(async (req, res) => {
  const { text, userId } = z.object({ text: z.string().min(1), userId: z.string().optional() }).parse(req.body);
  const trip = await prisma.trip.findFirst({
    where: { status: { in: ["PLANNING", "BOOKING"] } },
    include: { members: { include: { user: true } } },
    orderBy: { createdAt: "desc" },
  });
  if (!trip) return res.status(404).json({ error: "No active trip" });

  const activeUserId = userId || trip.organizerId;
  const member = trip.members.find((m) => m.userId === activeUserId) || trip.members[0];
  const { handleInboundMessage } = await import("../webhooks/photonWebhook");

  await handleInboundMessage({
    eventId: `web_${Date.now()}`,
    channel: (member.user.preferredChannel as any) || "imessage",
    from: member.user.phoneE164,
    to: config.photon.agentHandle,
    text,
  });

  res.json({ ok: true });
}));
