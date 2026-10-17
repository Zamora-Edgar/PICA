import { prisma } from "../db";
import { linkDefaultIdentities } from "../identity";
import { executeTool } from "../agent/tools";

export async function seedDemoData(): Promise<void> {
  console.log("🌱 Seeding TripSync database for Edgar, Omar, and Jairo...");

  await prisma.approvalRequest.deleteMany();
  await prisma.expenseSplit.deleteMany();
  await prisma.message.deleteMany();
  await prisma.itineraryItem.deleteMany();
  await prisma.tripMember.deleteMany();
  await prisma.spendingRule.deleteMany();
  await prisma.channelIdentity.deleteMany();
  await prisma.trip.deleteMany();
  await prisma.user.deleteMany();

  // 1. Create Team Users
  const edgar = await prisma.user.create({
    data: {
      name: "Edgar",
      phoneE164: "+13106788131",
      preferredChannel: "imessage",
      visaAgentTokenRef: "tok_edgar",
      spendingRule: {
        create: {
          autoApproveLimitCents: 5_000, // $50 auto-approve
          perTransactionMaxCents: 100_000, // $1000 cap
        },
      },
    },
  });

  const omar = await prisma.user.create({
    data: {
      name: "Omar",
      phoneE164: "+13236756677",
      preferredChannel: "imessage",
      visaAgentTokenRef: "tok_omar",
      spendingRule: {
        create: {
          autoApproveLimitCents: 5_000, // $50 auto-approve
          perTransactionMaxCents: 100_000,
        },
      },
    },
  });

  const jairo = await prisma.user.create({
    data: {
      name: "Jairo",
      phoneE164: "+16505550193",
      preferredChannel: "imessage",
      visaAgentTokenRef: "tok_jairo",
      spendingRule: {
        create: {
          autoApproveLimitCents: 5_000,
          perTransactionMaxCents: 100_000,
        },
      },
    },
  });

  // 2. Link multi-channel identities (iMessage, SMS, WhatsApp, Voice)
  await linkDefaultIdentities(edgar.id, edgar.phoneE164);
  await linkDefaultIdentities(omar.id, omar.phoneE164);
  await linkDefaultIdentities(jairo.id, jairo.phoneE164);

  // 3. Create Active Trip
  const trip = await prisma.trip.create({
    data: {
      name: "San Diego Weekend Getaway",
      destination: "San Diego",
      startDate: new Date("2026-10-24"),
      endDate: new Date("2026-10-25"),
      inviteCode: "SD2026",
      organizerId: edgar.id,
      members: {
        create: [
          { userId: edgar.id, role: "ORGANIZER", budgetCents: 40_000, likes: JSON.stringify(["Cars", "Beaches", "Good food"]) },
          { userId: omar.id, role: "MEMBER", budgetCents: 40_000, likes: JSON.stringify(["Photography", "Fine dining", "Exploring"]) },
          { userId: jairo.id, role: "MEMBER", budgetCents: 40_000, likes: JSON.stringify(["Surfing", "Tacos", "Music"]) },
        ],
      },
    },
  });

  // 4. Add Initial Itinerary Items
  const asEdgar = { tripId: trip.id, userId: edgar.id };
  await executeTool("add_item", { optionId: "htl_belem_apartment", dayIndex: 1 }, asEdgar);
  await executeTool("add_item", { optionId: "food_time_out", dayIndex: 1 }, asEdgar);
  await executeTool("add_item", { optionId: "act_surf_lesson", dayIndex: 2 }, asEdgar);
  await executeTool("add_item", { optionId: "food_seafood", dayIndex: 2 }, asEdgar);

  console.log(`✅ Seeded trip: "${trip.name}" (ID: ${trip.id})`);
  console.log(`   Members: Edgar (${edgar.phoneE164}), Omar (${omar.phoneE164}), Jairo (${jairo.phoneE164})`);
  console.log("   Initial itinerary items added and shares split evenly!");
}

if (require.main === module || process.argv[1]?.includes("seed")) {
  seedDemoData()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
}
