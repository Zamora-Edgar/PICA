/**
 * agent.ts
 * Uses Google Gemini to parse a raw text message into a structured shopping list.
 * Also generates the final human-friendly price comparison response.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { PriceResult } from "./prices";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-3.8-flash" });

// ─── Types ─────────────────────────────────────────────────────────────────────
export interface ParsedList {
  items: string[];
  isShoppingRequest: boolean;
  clarification?: string; // if message isn't a shopping list
}

// ─── Parse incoming text message into shopping items ──────────────────────────
export async function parseShoppingList(message: string): Promise<ParsedList> {
  const prompt = `
You are CartBot, an AI shopping assistant. Analyze this user message and extract their shopping list.

User message: "${message}"

Respond ONLY with a JSON object like this (no markdown, no code blocks):
{
  "items": ["item1", "item2", "item3"],
  "isShoppingRequest": true,
  "clarification": null
}

Rules:
- If it IS a shopping request: extract each item as a clean, searchable product name
- Normalize items (e.g. "eggs" → "large eggs", "tylenol" → "Tylenol pain reliever")
- If it is NOT a shopping list (e.g. a greeting or random question): set isShoppingRequest to false and put a helpful response in clarification
- Max 15 items
- Remove quantities (we'll find best price regardless)
`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean) as ParsedList;
  } catch (err) {
    console.warn("⚠️ Gemini parse fallback triggered:", (err as Error).message);
    // Deterministic fallback: split by comma, 'and', or newline
    const rawItems = message
      .split(/,|\band\b|\n/i)
      .map((s) => s.replace(/^[-\s*•]+/, "").trim())
      .filter((s) => s.length > 1 && !/^(i need|please|can you|buy|get|find me)/i.test(s));

    return {
      items: rawItems.length > 0 ? rawItems : [message.trim()],
      isShoppingRequest: true,
    };
  }
}

// ─── Deterministic text message builder (fast & zero failure rate) ─────────────
export function formatPriceReplyDirect(results: PriceResult[]): string {
  const lines: string[] = ["🛒 CartBot found your prices!\n"];
  let totalCheapest = 0;

  for (const r of results) {
    if (r.cheapest) {
      lines.push(`• ${r.item} → ${r.cheapest.store}: ${r.cheapest.priceFormatted} ✅ cheapest`);
      totalCheapest += r.cheapest.price;
    } else {
      lines.push(`• ${r.item} → ⚠️ couldn't find price`);
    }
  }

  if (totalCheapest > 0) {
    lines.push(`\n💰 Total cheapest: ~$${totalCheapest.toFixed(2)}`);
  }

  lines.push(`\nReply "CART" to create your Walmart cart!`);
  return lines.join("\n");
}

// ─── Build the reply message from price results ────────────────────────────────
export async function buildReplyMessage(
  items: string[],
  results: PriceResult[]
): Promise<string> {
  const prompt = `
You are CartBot, a friendly AI shopping assistant. Format this price comparison into a clean, concise text message reply (SMS-friendly, no markdown, use emojis sparingly).

Original items: ${items.join(", ")}

Price results from stores:
${JSON.stringify(results, null, 2)}

Format the reply like this example style:
---
🛒 CartBot found your prices!

• Milk → Target $3.59 ✅ cheapest
• Eggs → Kroger $1.99 ✅ cheapest
• Butter → Walmart $4.46 ✅ cheapest

💰 Best total if you split: ~$10.04

Reply "CART" to auto-add cheapest items to your Walmart cart!
---

Rules:
- Keep it concise for iMessage/SMS
- Always show the cheapest option with ✅
- If results are missing for an item, say "⚠️ [item] - couldn't find price"
- End with the CART action prompt
`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    if (text) return text;
    return formatPriceReplyDirect(results);
  } catch (err) {
    console.warn("⚠️ Gemini reply formatting fallback triggered:", (err as Error).message);
    return formatPriceReplyDirect(results);
  }
}

// ─── Handle "CART" reply to trigger cart automation ───────────────────────────
export async function handleCartRequest(items: string[]): Promise<string> {
  try {
    const prompt = `
You are CartBot. The user replied "CART" to auto-add items to their Walmart cart.
Generate a friendly SMS confirmation message that:
1. Says you're building their Walmart cart now
2. Lists the items being added (${items.join(", ")})
3. Says they'll get a link in 30 seconds

Keep it under 160 chars. Use 1-2 emojis max. No markdown.
`;
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch {
    return `🛒 Creating your Walmart cart for: ${items.join(", ")}! Hang tight, link coming right up.`;
  }
}
