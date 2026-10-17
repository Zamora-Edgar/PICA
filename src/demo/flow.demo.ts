/**
 * Run: npm run demo:flow
 *
 * End-to-end walkthrough of the purchase + approval flow with Photon and Visa in mock mode.
 * No API keys needed: it skips the LLM and calls the agent's tools directly, then feeds fake
 * Photon webhook events through the real handler.
 *
 * ⚠️ Wipes the local dev database (prisma/dev.db) before running.
 *
 * Reading the output:
 *   [photon:mock] → channel:address   a message TripSync would send (to whom, on which channel)
 *   [visa:mock] authorize/capture/void a Visa call that would move money
 *   DB: ...                            what ended up in the database
 */
import { prisma } from "../db";
import { linkDefaultIdentities } from "../identity";
import { executeTool } from "../agent/tools";
import { handleInboundMessage } from "../webhooks/photonWebhook";

const step = (title: string) => console.log(`\n━━━ ${title} ━━━`);

async function itemState(itemId: string) {
  const item = await prisma.itineraryItem.findUniqueOrThrow({
    where: { id: itemId },
    include: { splits: { include: { user: true } } },
  });
  const splits = item.splits.map((s) => `${s.user.name} $${s.amountCents / 100} ${s.status}`).join(", ");
  console.log(`DB: ${item.title} → ${item.status}${splits ? ` | ${splits}` : ""}`);
}

async function main() {
  await prisma.approvalRequest.deleteMany();
  await prisma.expenseSplit.deleteMany();
  await prisma.message.deleteMany();
  await prisma.itineraryItem.deleteMany();
  await prisma.tripMember.deleteMany();
  await prisma.spendingRule.deleteMany();
  await prisma.channelIdentity.deleteMany();
  await prisma.trip.deleteMany();
  await prisma.user.deleteMany();

  step("Setup: Ana (WhatsApp, auto-buy ≤ $400) and Ben (iMessage, auto-buy ≤ $100)");
  const ana = await prisma.user.create({
    data: { name: "Ana", phoneE164: "+15551110001", preferredChannel: "whatsapp", visaAgentTokenRef: "tok_ana",
      spendingRule: { create: { autoApproveLimitCents: 40_000 } } },
  });
  const ben = await prisma.user.create({
    data: { name: "Ben", phoneE164: "+15551110002", preferredChannel: "imessage", visaAgentTokenRef: "tok_ben",
      spendingRule: { create: { autoApproveLimitCents: 10_000 } } },
  });
  await linkDefaultIdentities(ana.id, ana.phoneE164);
  await linkDefaultIdentities(ben.id, ben.phoneE164);
  const trip = await prisma.trip.create({
    data: {
      name: "Lisbon Weekend", destination: "Lisbon", startDate: new Date("2026-11-06"), endDate: new Date("2026-11-09"),
      inviteCode: "demo", organizerId: ana.id,
      members: { create: [{ userId: ana.id, role: "ORGANIZER", budgetCents: 80_000 }, { userId: ben.id, budgetCents: 50_000 }] },
    },
  });
  const asAna = { tripId: trip.id, userId: ana.id };

  step("1. Agent adds a $900 hotel, then Ana says 'make the hotel cheaper' → swapped for $600");
  const hotel = (await executeTool("add_item", { optionId: "htl_alfama_boutique", dayIndex: 1 }, asAna)).data as { added: string };
  console.log((await executeTool("replace_item", { itemId: hotel.added, optionId: "htl_belem_apartment" }, asAna)).data);
  console.log("Cost per person:", (await executeTool("get_cost_breakdown", {}, asAna)).data);

  step("2. Ana asks to book → trust layer checks each $300 share against each person's Visa rules");
  const summary = await executeTool("request_purchase", { itemIds: [hotel.added] }, asAna);
  console.log(JSON.stringify(summary.data, null, 2));
  await itemState(hotel.added);

  step("3. Ben approves by PHONE CALL (the request went to his iMessage) — same user, same trip");
  const code = (await prisma.approvalRequest.findFirstOrThrow({ where: { userId: ben.id, status: "PENDING" } })).code;
  await handleInboundMessage({ eventId: "evt_1", channel: "voice", from: "+1 (555) 111-0002", to: "photon", text: `Yes, ${code}.`, callId: "call_1" });
  await itemState(hotel.added);

  step("4. Photon retries the same webhook → ignored, nothing charged twice");
  await handleInboundMessage({ eventId: "evt_1", channel: "voice", from: "+15551110002", to: "photon", text: `Yes, ${code}.`, callId: "call_1" });
  await itemState(hotel.added);

  step("5. Surf lesson ($400): Ana auto-approved, Ben says NO on WhatsApp → Ana's hold is voided");
  const surf = (await executeTool("add_item", { optionId: "act_surf_lesson", dayIndex: 2 }, asAna)).data as { added: string };
  await executeTool("request_purchase", { itemIds: [surf.added] }, asAna);
  await handleInboundMessage({ eventId: "evt_2", channel: "whatsapp", from: "whatsapp:+15551110002", to: "photon", text: "no" });
  await itemState(surf.added);

  step("6. Ben: 'I don't want to do the surf lesson' → opts out, shares recalculated");
  await executeTool("set_participation", { itemId: surf.added, participating: false }, { tripId: trip.id, userId: ben.id });
  console.log("Cost per person:", (await executeTool("get_cost_breakdown", {}, asAna)).data);

  step("Unified thread: every message across all channels, in order");
  const messages = await prisma.message.findMany({ where: { tripId: trip.id }, orderBy: { createdAt: "asc" }, include: { user: true } });
  for (const m of messages) console.log(`${m.direction === "INBOUND" ? "←" : "→"} ${m.user?.name} [${m.channel}] ${m.body}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
