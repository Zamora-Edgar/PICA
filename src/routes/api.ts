/**
 * REST API for the web dashboard: create a trip, join via invite link, link a Visa card,
 * and read the live itinerary + per-person costs.
 */
import { randomBytes } from "node:crypto";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { computeCostBreakdown, loadTripSnapshot } from "../agent/tripContext";
import { policyFromRecord } from "../commerce/trustLayer";
import { config } from "../config";
import { prisma } from "../db";
import { ITEM_CATEGORIES } from "../domain/types";
import { linkDefaultIdentities, normalizeAddress } from "../identity";
import { CHANNELS, createInviteLink } from "../integrations/photon";
import { syncAgentControls } from "../integrations/visa";
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
  await notifyUser(user.id, `Welcome to ${trip.name}, ${user.name}! I'm TripSync ✈️ Text me here${callLine} anytime to shape the plan.`, trip.id);
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
    take: 20,
    include: { user: true },
  });
  res.json({ trip: snapshot, costs: computeCostBreakdown(snapshot), messages });
}));
