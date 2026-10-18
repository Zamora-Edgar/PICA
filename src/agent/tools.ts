/**
 * The agent's toolbox. The LLM can only change state through these functions, and each one
 * validates its arguments and enforces invariants (e.g. purchased items can't be edited).
 * Note what's missing: there is no "approve_payment" tool. The model can ask the trust layer
 * to start a purchase; it can never approve one.
 */
import type OpenAI from "openai";
import { z } from "zod";
import { cancelBooking, initiatePurchase } from "../commerce/purchaseOrchestrator";
import { buildWallet } from "../commerce/wallet";
import { prisma } from "../db";
import { formatUsd, ITEM_CATEGORIES, parseJsonArray } from "../domain/types";
import { getMerchantOffers } from "../integrations/visa";
import { CATALOG, getCatalogOption, matchesDestination, searchCatalog } from "./catalog";
import { recommendForTrip } from "./recommender";
import { computeCostBreakdown, loadTripSnapshot } from "./tripContext";

export interface ToolContext {
  tripId: string;
  userId: string; // the member who sent the message
}

export interface ToolResult {
  data: unknown;
  itineraryChanged?: boolean;
}

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } }) as const;

export const TOOL_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  fn("change_destination", "Change the trip's destination to another city ('San Diego', 'New York', or 'Florida/Miami'). Updates the trip location, resets unbooked itinerary items, and refreshes hotel and activity options for the new city.", {
    destination: { type: "string", description: "The destination to switch to: 'San Diego', 'New York', or 'Florida'" },
    tripName: { type: "string", description: "Optional new trip title, e.g. 'New York City Explorer'" },
  }, ["destination"]),
  fn("search_options", "Search bookable options. Use before adding or replacing anything; results are sorted cheapest first.", {
    category: { type: "string", enum: [...ITEM_CATEGORIES] },
    maxPriceCents: { type: "integer", description: "Max group total in cents" },
    query: { type: "string", description: "Keyword, e.g. 'beach', 'broadway', 'budget'" },
    destination: { type: "string", description: "Optional city filter: 'San Diego', 'New York', or 'Florida'" },
  }),
  fn("add_item", "Add a catalog option to the itinerary.", {
    optionId: { type: "string" },
    dayIndex: { type: "integer", minimum: 1 },
  }, ["optionId", "dayIndex"]),
  fn("replace_item", "Swap an itinerary item for a different catalog option (e.g. a cheaper hotel).", {
    itemId: { type: "string" },
    optionId: { type: "string" },
  }, ["itemId", "optionId"]),
  fn("remove_item", "Remove an item from the itinerary for everyone.", { itemId: { type: "string" } }, ["itemId"]),
  fn("set_participation", "Opt the CURRENT SPEAKER in or out of an item. Opting out removes their share; others' shares are recalculated.", {
    itemId: { type: "string" },
    participating: { type: "boolean" },
  }, ["itemId", "participating"]),
  fn("get_cost_breakdown", "Get each member's current total vs budget.", {}),
  fn("adjust_to_budget", "Automatically rebalances and adjusts the itinerary to fit within budget limits by swapping expensive items for cheaper options or removing non-essential items.", {
    targetBudgetDollars: { type: "number", description: "Target dollar amount per person, e.g. 300" },
    newMemberBudgetDollars: { type: "number", description: "If the speaker wants to set their personal budget limit to a new number in dollars, e.g. 250" },
  }),
  fn("update_budget", "Update the speaker's (or a specified member's) trip budget limit in dollars, e.g. 300.", {
    budgetDollars: { type: "number", description: "The new budget limit in dollars" },
    memberName: { type: "string", description: "Optional name of member to update" },
  }, ["budgetDollars"]),
  fn("remind_members", "Alert or send a reminder text to group members to review the itinerary and confirm their Visa share.", {
    memberName: { type: "string", description: "Specific member to remind (e.g. 'Omar', 'Jairo'), or 'all' to alert everyone who hasn't confirmed yet." },
    message: { type: "string", description: "Optional custom note to include in the reminder." },
  }),
  fn("recommend_options", "Personalized picks for THIS group, ranked by members' likes/dislikes, remaining budgets and Visa offers, each with reasons. Use for 'what should we do', 'suggest something', 'what's best for us'.", {
    category: { type: "string", enum: [...ITEM_CATEGORIES] },
  }),
  fn("get_rewards", "The speaker's Visa wallet: PICA points, loyalty tier, Visa offer cash back, receipts and pending approvals.", {}),
  fn("cancel_booking", "Cancel a BOOKED (purchased) item and refund every member's share to their card. Only when a member explicitly asks to cancel something already booked.", {
    itemId: { type: "string" },
  }, ["itemId"]),
  fn("request_purchase", "Start booking items. Only when a member explicitly asks to book/buy. Each person's share is checked against their Visa spending rules; some may need their approval.", {
    itemIds: { type: "array", items: { type: "string" }, minItems: 1 },
  }, ["itemIds"]),
];

const schemas = {
  change_destination: z.object({
    destination: z.string(),
    tripName: z.string().optional(),
  }),
  search_options: z.object({
    category: z.enum(ITEM_CATEGORIES).optional(),
    maxPriceCents: z.number().int().positive().optional(),
    query: z.string().optional(),
    destination: z.string().optional(),
  }),
  add_item: z.object({ optionId: z.string(), dayIndex: z.number().int().min(1) }),
  replace_item: z.object({ itemId: z.string(), optionId: z.string() }),
  remove_item: z.object({ itemId: z.string() }),
  set_participation: z.object({ itemId: z.string(), participating: z.boolean() }),
  get_cost_breakdown: z.object({}),
  adjust_to_budget: z.object({
    targetBudgetDollars: z.number().positive().optional(),
    newMemberBudgetDollars: z.number().positive().optional(),
  }),
  update_budget: z.object({
    budgetDollars: z.number().positive(),
    memberName: z.string().optional(),
  }),
  remind_members: z.object({
    memberName: z.string().optional(),
    message: z.string().optional(),
  }),
  recommend_options: z.object({ category: z.enum(ITEM_CATEGORIES).optional() }),
  get_rewards: z.object({}),
  cancel_booking: z.object({ itemId: z.string() }),
  request_purchase: z.object({ itemIds: z.array(z.string()).min(1) }),
};
type ToolName = keyof typeof schemas;

export async function executeTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  if (!(name in schemas)) return { data: { error: `Unknown tool ${name}` } };
  const parsed = schemas[name as ToolName].safeParse(rawArgs);
  if (!parsed.success) return { data: { error: "Invalid arguments", issues: parsed.error.issues } };
  const args = parsed.data as any;

  switch (name as ToolName) {
    case "change_destination": {
      const raw = String(args.destination || "").toLowerCase();
      let city: "San Diego" | "New York" | "Florida" = "San Diego";
      let fullName = "San Diego Weekend Getaway";
      if (raw.includes("new york") || raw.includes("nyc") || raw.includes("manhattan") || raw.includes("ny")) {
        city = "New York";
        fullName = "New York City Explorer";
      } else if (raw.includes("florida") || raw.includes("miami") || raw.includes("orlando") || raw.includes("key west") || raw.includes("fl")) {
        city = "Florida";
        fullName = "Florida Sunshine Getaway";
      }

      const tripName = args.tripName || fullName;

      // Update trip destination and title
      await prisma.trip.update({
        where: { id: ctx.tripId },
        data: { destination: city, name: tripName },
      });

      // Clear proposed items from previous destination so itinerary matches the new city
      await prisma.itineraryItem.deleteMany({
        where: { tripId: ctx.tripId, status: "PROPOSED" },
      });

      // Auto-seed starter hotel for the new destination
      const starterOptions = CATALOG.filter((o) => o.destination === city && o.category === "LODGING");
      const starterHotel = starterOptions[1] || starterOptions[0];
      if (starterHotel) {
        await prisma.itineraryItem.create({
          data: {
            tripId: ctx.tripId,
            dayIndex: 1,
            category: starterHotel.category,
            title: starterHotel.title,
            description: starterHotel.description,
            catalogOptionId: starterHotel.id,
            merchantName: starterHotel.merchantName,
            priceCents: starterHotel.priceCents,
          },
        });
      }

      return {
        data: {
          destination: city,
          tripName,
          starterHotel: starterHotel?.title,
          message: `Destination switched to ${city}! Cleared previous items and selected ${starterHotel?.title || "new lodging"}.`,
        },
        itineraryChanged: true,
      };
    }

    case "search_options": {
      const trip = await prisma.trip.findUnique({ where: { id: ctx.tripId } });
      const dest = args.destination || trip?.destination;
      return { data: searchCatalog({ ...args, destination: dest }) };
    }

    case "add_item": {
      const option = getCatalogOption(args.optionId);
      if (!option) return { data: { error: "Unknown optionId — call search_options first." } };
      const item = await prisma.itineraryItem.create({
        data: {
          tripId: ctx.tripId,
          dayIndex: args.dayIndex,
          category: option.category,
          title: option.title,
          description: option.description,
          catalogOptionId: option.id,
          merchantName: option.merchantName,
          priceCents: option.priceCents,
        },
      });
      return { data: { added: item.id, title: item.title }, itineraryChanged: true };
    }

    case "replace_item": {
      const item = await findEditableItem(ctx.tripId, args.itemId);
      const option = getCatalogOption(args.optionId);
      if (!item) return { data: { error: "Item not found or already booked." } };
      if (!option) return { data: { error: "Unknown optionId — call search_options first." } };
      await prisma.itineraryItem.update({
        where: { id: item.id },
        data: {
          category: option.category,
          title: option.title,
          description: option.description,
          catalogOptionId: option.id,
          merchantName: option.merchantName,
          priceCents: option.priceCents,
          version: { increment: 1 },
        },
      });
      return { data: { replaced: item.title, with: option.title, oldPriceCents: item.priceCents, newPriceCents: option.priceCents }, itineraryChanged: true };
    }

    case "remove_item": {
      const item = await findEditableItem(ctx.tripId, args.itemId);
      if (!item) return { data: { error: "Item not found or already booked." } };
      await prisma.itineraryItem.update({ where: { id: item.id }, data: { status: "REMOVED", version: { increment: 1 } } });
      return { data: { removed: item.title }, itineraryChanged: true };
    }

    case "set_participation": {
      const item = await findEditableItem(ctx.tripId, args.itemId);
      if (!item) return { data: { error: "Item not found or already booked." } };
      const optOuts = new Set(parseJsonArray(item.optOutUserIds));
      if (args.participating) optOuts.delete(ctx.userId);
      else optOuts.add(ctx.userId);
      await prisma.itineraryItem.update({
        where: { id: item.id },
        data: { optOutUserIds: JSON.stringify([...optOuts]), version: { increment: 1 } },
      });
      return { data: { item: item.title, participating: args.participating }, itineraryChanged: true };
    }

    case "get_cost_breakdown":
      return { data: computeCostBreakdown(await loadTripSnapshot(ctx.tripId)) };

    case "adjust_to_budget": {
      if (args.newMemberBudgetDollars) {
        await prisma.tripMember.updateMany({
          where: { tripId: ctx.tripId, userId: ctx.userId },
          data: { budgetCents: Math.round(args.newMemberBudgetDollars * 100) },
        });
      }

      let trip = await loadTripSnapshot(ctx.tripId);
      const speakerMember = trip.members.find((m) => m.userId === ctx.userId);
      const targetCents = args.targetBudgetDollars
        ? Math.round(args.targetBudgetDollars * 100)
        : (speakerMember?.budgetCents ?? 30_000);

      const changesMade: string[] = [];

      // Step A: Lodging optimization
      const stayItem = trip.items.find((i) => i.category === "LODGING" && i.status === "PROPOSED");
      if (stayItem) {
        const destLodgings = CATALOG.filter((o) => o.category === "LODGING" && matchesDestination(o.destination, trip.destination))
          .sort((a, b) => a.priceCents - b.priceCents);
        const cheaper = destLodgings.find((o) => o.priceCents < stayItem.priceCents);
        if (cheaper) {
          await prisma.itineraryItem.update({
            where: { id: stayItem.id },
            data: {
              title: cheaper.title,
              description: cheaper.description,
              catalogOptionId: cheaper.id,
              merchantName: cheaper.merchantName,
              priceCents: cheaper.priceCents,
              version: { increment: 1 },
            },
          });
          const saved = Math.round((stayItem.priceCents - cheaper.priceCents) / 100);
          changesMade.push(`Swapped lodging to ${cheaper.title} (saved $${saved} total)`);
        }
      }

      // Step B: Activity optimization
      trip = await loadTripSnapshot(ctx.tripId);
      let costs = computeCostBreakdown(trip);
      let speakerCost = costs.find((c) => c.userId === ctx.userId)?.totalCents ?? 0;

      if (speakerCost > targetCents) {
        const expensiveAct = trip.items.find((i) => i.category === "ACTIVITY" && i.status === "PROPOSED" && i.priceCents >= 20_000);
        if (expensiveAct) {
          const destActs = CATALOG.filter((o) => o.category === "ACTIVITY" && matchesDestination(o.destination, trip.destination))
            .sort((a, b) => a.priceCents - b.priceCents);
          const cheaperAct = destActs.find((o) => o.priceCents < expensiveAct.priceCents);
          if (cheaperAct) {
            await prisma.itineraryItem.update({
              where: { id: expensiveAct.id },
              data: {
                title: cheaperAct.title,
                description: cheaperAct.description,
                catalogOptionId: cheaperAct.id,
                merchantName: cheaperAct.merchantName,
                priceCents: cheaperAct.priceCents,
                version: { increment: 1 },
              },
            });
            const saved = Math.round((expensiveAct.priceCents - cheaperAct.priceCents) / 100);
            changesMade.push(`Swapped ${expensiveAct.title} to ${cheaperAct.title} (saved $${saved} total)`);
          }
        }
      }

      // Step C: Food optimization
      trip = await loadTripSnapshot(ctx.tripId);
      costs = computeCostBreakdown(trip);
      speakerCost = costs.find((c) => c.userId === ctx.userId)?.totalCents ?? 0;

      if (speakerCost > targetCents) {
        const expensiveFood = trip.items.find((i) => i.category === "FOOD" && i.status === "PROPOSED" && i.priceCents > 15_000);
        if (expensiveFood) {
          const destFoods = CATALOG.filter((o) => o.category === "FOOD" && matchesDestination(o.destination, trip.destination))
            .sort((a, b) => a.priceCents - b.priceCents);
          const cheaperFood = destFoods.find((o) => o.priceCents < expensiveFood.priceCents);
          if (cheaperFood) {
            await prisma.itineraryItem.update({
              where: { id: expensiveFood.id },
              data: {
                title: cheaperFood.title,
                description: cheaperFood.description,
                catalogOptionId: cheaperFood.id,
                merchantName: cheaperFood.merchantName,
                priceCents: cheaperFood.priceCents,
                version: { increment: 1 },
              },
            });
            changesMade.push(`Swapped ${expensiveFood.title} to ${cheaperFood.title}`);
          }
        }
      }

      trip = await loadTripSnapshot(ctx.tripId);
      const finalCosts = computeCostBreakdown(trip);
      const newSpeakerCost = finalCosts.find((c) => c.userId === ctx.userId);

      return {
        data: {
          success: true,
          changes: changesMade.length ? changesMade : ["Plan is already within budget!"],
          newShare: `$${((newSpeakerCost?.totalCents ?? 0) / 100).toFixed(2)}`,
          targetBudget: `$${(targetCents / 100).toFixed(0)}`,
          allCosts: finalCosts.map((c) => `${c.name}: $${(c.totalCents / 100).toFixed(2)}`),
        },
        itineraryChanged: changesMade.length > 0,
      };
    }

    case "update_budget": {
      const budgetCents = Math.round(args.budgetDollars * 100);
      let targetUserId = ctx.userId;
      if (args.memberName) {
        const member = await prisma.tripMember.findFirst({
          where: { tripId: ctx.tripId, user: { name: { contains: args.memberName } } },
        });
        if (member) targetUserId = member.userId;
      }
      await prisma.tripMember.updateMany({
        where: { tripId: ctx.tripId, userId: targetUserId },
        data: { budgetCents },
      });
      const updated = await loadTripSnapshot(ctx.tripId);
      return {
        data: {
          success: true,
          updatedBudget: `$${args.budgetDollars.toFixed(0)}`,
          costs: computeCostBreakdown(updated).map((c) => `${c.name}: $${(c.totalCents / 100).toFixed(2)} of $${((c.budgetCents ?? 0) / 100).toFixed(0)}`),
        },
      };
    }

    case "remind_members": {
      const trip = await loadTripSnapshot(ctx.tripId);
      const speaker = trip.members.find((m) => m.userId === ctx.userId)?.user.name || "A friend";
      const costs = computeCostBreakdown(trip);

      const targets = trip.members.filter((m) => {
        if (m.userId === ctx.userId) return false;
        if (args.memberName && args.memberName.toLowerCase() !== "all") {
          return m.user.name.toLowerCase().includes(args.memberName.toLowerCase());
        }
        return true;
      });

      const remindedNames: string[] = [];
      const { notifyUser } = await import("../notifications");

      for (const target of targets) {
        const cost = costs.find((c) => c.userId === target.userId);
        const shareUsd = ((cost?.totalCents ?? 0) / 100).toFixed(2);
        const note = args.message ? `\n"${args.message}"` : "";

        const reminderText =
          `🔔 PICA Reminder from ${speaker}!\n` +
          `Hey ${target.user.name}! We're reviewing our trip "${trip.name}". Your current share is $${shareUsd}.${note}\n\n` +
          `Reply "YES" to confirm your share, or text any adjustments!`;

        await notifyUser(target.userId, reminderText, ctx.tripId);
        remindedNames.push(target.user.name);
      }

      return {
        data: {
          success: true,
          reminded: remindedNames,
          message: `Sent reminders to: ${remindedNames.join(", ")}`,
        },
      };
    }

    case "recommend_options": {
      const recs = recommendForTrip(await loadTripSnapshot(ctx.tripId), await getMerchantOffers(), { category: args.category, limit: 3 });
      return {
        data: recs.map((r) => ({
          optionId: r.option.id,
          title: r.option.title,
          perPerson: formatUsd(r.perPersonCents),
          score: r.score,
          why: r.reasons,
        })),
      };
    }

    case "get_rewards": {
      const me = (await buildWallet(ctx.tripId)).members.find((m) => m.userId === ctx.userId);
      if (!me) return { data: { error: "Not a member of this trip." } };
      return {
        data: {
          points: me.rewards.points,
          tier: me.rewards.tier,
          pointsToNextTier: me.rewards.nextTier ? `${me.rewards.pointsToNext} to ${me.rewards.nextTier}` : "top tier",
          visaCashback: formatUsd(me.rewards.cashbackCents),
          spentOnTrip: formatUsd(me.spentCents),
          pendingApprovals: me.pendingApprovals.map((a) => `${a.item}: ${formatUsd(a.amountCents)}`),
        },
      };
    }

    case "cancel_booking": {
      const result = await cancelBooking(ctx.tripId, args.itemId);
      return { data: result, itineraryChanged: result.ok };
    }

    case "request_purchase": {
      // Hand-off to the Visa trust layer. Results tell the model who was auto-charged,
      // who was asked to approve, and who was blocked — it must relay that honestly.
      const summary = await initiatePurchase(ctx.tripId, args.itemIds);
      return { data: summary.length ? summary : { error: "No bookable (PROPOSED) items matched those ids." }, itineraryChanged: true };
    }
  }
}

async function findEditableItem(tripId: string, itemId: string) {
  return prisma.itineraryItem.findFirst({ where: { id: itemId, tripId, status: "PROPOSED" } });
}
