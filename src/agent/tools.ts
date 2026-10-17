/**
 * The agent's toolbox. The LLM can only change state through these functions, and each one
 * validates its arguments and enforces invariants (e.g. purchased items can't be edited).
 * Note what's missing: there is no "approve_payment" tool. The model can ask the trust layer
 * to start a purchase; it can never approve one.
 */
import type OpenAI from "openai";
import { z } from "zod";
import { initiatePurchase } from "../commerce/purchaseOrchestrator";
import { prisma } from "../db";
import { ITEM_CATEGORIES, parseJsonArray } from "../domain/types";
import { getCatalogOption, searchCatalog } from "./catalog";
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
  fn("search_options", "Search bookable options. Use before adding or replacing anything; results are sorted cheapest first.", {
    category: { type: "string", enum: [...ITEM_CATEGORIES] },
    maxPriceCents: { type: "integer", description: "Max group total in cents" },
    query: { type: "string", description: "Keyword, e.g. 'beach', 'history', 'budget'" },
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
  fn("request_purchase", "Start booking items. Only when a member explicitly asks to book/buy. Each person's share is checked against their Visa spending rules; some may need their approval.", {
    itemIds: { type: "array", items: { type: "string" }, minItems: 1 },
  }, ["itemIds"]),
];

const schemas = {
  search_options: z.object({
    category: z.enum(ITEM_CATEGORIES).optional(),
    maxPriceCents: z.number().int().positive().optional(),
    query: z.string().optional(),
  }),
  add_item: z.object({ optionId: z.string(), dayIndex: z.number().int().min(1) }),
  replace_item: z.object({ itemId: z.string(), optionId: z.string() }),
  remove_item: z.object({ itemId: z.string() }),
  set_participation: z.object({ itemId: z.string(), participating: z.boolean() }),
  get_cost_breakdown: z.object({}),
  request_purchase: z.object({ itemIds: z.array(z.string()).min(1) }),
};
type ToolName = keyof typeof schemas;

export async function executeTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  if (!(name in schemas)) return { data: { error: `Unknown tool ${name}` } };
  const parsed = schemas[name as ToolName].safeParse(rawArgs);
  if (!parsed.success) return { data: { error: "Invalid arguments", issues: parsed.error.issues } };
  const args = parsed.data as any;

  switch (name as ToolName) {
    case "search_options":
      return { data: searchCatalog(args) };

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
