/**
 * Run: npm run demo:journey
 *
 * The full Visa shopping journey on the seeded San Diego trip, in mock mode, no API keys:
 *   discovery → decision-making → personalization → checkout → payments → loyalty → post-purchase
 * plus the trust kill switch. Uses the real tools, orchestrator and webhook handler; skips the LLM.
 *
 * ⚠️ Re-seeds the local dev database (prisma/dev.db).
 */
import { prisma } from "../db";
import { executeTool } from "../agent/tools";
import { buildWallet } from "../commerce/wallet";
import { formatUsd } from "../domain/types";
import { handleInboundMessage } from "../webhooks/photonWebhook";
import { seedDemoData } from "./seed";

const step = (title: string) => console.log(`\n━━━ ${title} ━━━`);

async function main() {
  await seedDemoData();
  const trip = await prisma.trip.findFirstOrThrow({ include: { members: { include: { user: true } } } });
  const asEdgar = { tripId: trip.id, userId: trip.organizerId };
  const items = await prisma.itineraryItem.findMany({ where: { tripId: trip.id } });
  const byOption = (id: string) => items.find((i) => i.catalogOptionId === id)!;

  step("1-3. Discovery, decision-making & personalization: ranked picks with reasons");
  for (const r of (await executeTool("recommend_options", {}, asEdgar)).data as { title: string; perPerson: string; score: number; why: string[] }[]) {
    console.log(`  ${r.score}%  ${r.title} (${r.perPerson}/person)\n        ${r.why.join("\n        ")}`);
  }

  step("4-5. Checkout & payments: lunch is $40/person, under everyone's $50 auto-buy → captured at once");
  console.log(JSON.stringify((await executeTool("request_purchase", { itemIds: [byOption("food_time_out").id] }, asEdgar)).data, null, 2));

  step("4-5. Surf lesson is $133/person → each member must approve on their own phone");
  await executeTool("request_purchase", { itemIds: [byOption("act_surf_lesson").id] }, asEdgar);
  const approvals = await prisma.approvalRequest.findMany({ where: { status: "PENDING" }, include: { user: true } });
  for (const [i, a] of approvals.entries()) {
    await handleInboundMessage({ eventId: `demo_${i}`, channel: "imessage", from: a.user.phoneE164, to: "photon", text: `YES ${a.code}` });
  }

  step("6. Loyalty & rewards: points + Visa offer cash back per member");
  const wallet = await buildWallet(trip.id);
  for (const m of wallet.members) {
    console.log(`  ${m.name}: ${m.rewards.points} pts (${m.rewards.tier}), ${formatUsd(m.rewards.cashbackCents)} back, charged ${formatUsd(m.spentCents)}`);
  }

  step("7. Post-purchase: Jairo texts 'cancel surf' → everyone refunded, points reversed");
  const jairo = trip.members.find((m) => m.user.name === "Jairo")!.user;
  await handleInboundMessage({ eventId: "demo_cancel", channel: "imessage", from: jairo.phoneE164, to: "photon", text: "cancel surf" });
  for (const m of (await buildWallet(trip.id)).members) {
    console.log(`  ${m.name}: ${m.rewards.points} pts, refunded ${formatUsd(m.refundedCents)}`);
  }

  step("Trust: Omar revokes PICA's Visa credential → the next booking is hard-blocked, nobody charged");
  const omar = trip.members.find((m) => m.user.name === "Omar")!.user;
  await prisma.user.update({ where: { id: omar.id }, data: { visaAgentTokenRef: null } });
  console.log(JSON.stringify((await executeTool("request_purchase", { itemIds: [byOption("food_seafood").id] }, asEdgar)).data, null, 2));

  step("Audit trail (newest first)");
  for (const a of (await buildWallet(trip.id)).audit) {
    const failed = a.checks.filter((c) => !c.passed).map((c) => c.name);
    console.log(`  ${a.member.padEnd(6)} ${a.item.slice(0, 38).padEnd(38)} ${formatUsd(a.amountCents).padStart(8)}  ${a.decision.padEnd(16)} ${a.status.padEnd(9)} ${a.consentType ?? ""} ${failed.length ? `failed: ${failed.join(",")}` : ""}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
