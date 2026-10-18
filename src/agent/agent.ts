/**
 * The planning agent: one tool-calling loop over an OpenAI-compatible chat API.
 * Works with OpenAI directly, or with Gemini by setting LLM_BASE_URL to Gemini's
 * OpenAI-compatible endpoint — no code changes.
 */
import OpenAI from "openai";
import { config } from "../config";
import type { Channel } from "../integrations/photon";
import { executeTool, TOOL_DEFINITIONS } from "./tools";
import { loadConversationHistory, loadTripSnapshot, renderTripContext } from "./tripContext";

let client: OpenAI | undefined; // created on first use so the server boots without an API key
const llm = () => (client ??= new OpenAI({ apiKey: config.llm.apiKey, baseURL: config.llm.baseURL }));
const MAX_TOOL_ROUNDS = 8;

export interface AgentInput {
  tripId: string;
  userId: string;
  userName: string;
  channel: Channel;
  text: string;
}

export interface AgentResult {
  reply: string;
  itineraryChanged: boolean;
}

function systemPrompt(tripContext: string, input: AgentInput): string {
  const voice =
    input.channel === "voice"
      ? "They are on a PHONE CALL: your reply is read aloud. Two or three short sentences, no lists, no emoji, no ids, say amounts naturally (\"about a hundred fifty dollars each\")."
      : "They are texting: be concise and friendly, short lines, light emoji OK. Never show internal ids.";

  return `You are PICA (Personal Itinerary Commerce Agent), an autonomous AI travel coordinator for group trips. You talk to group members across iMessage, SMS, WhatsApp, and phone calls.

HOW THE CONVERSATION WORKS
- The history is ONE shared thread for the whole trip across every channel. Lines are tagged [Name via channel].
- A person may text on WhatsApp or iMessage and later call you — it's the same conversation; continue naturally.
- CRITICAL: NEVER include recipient tags or annotations like "(to Edgar via imessage)" or "[Name via channel]" in your reply. Speak directly and naturally to the person.

RULES & CAPABILITIES
- Change the itinerary ONLY through tools, and only with options from search_options or adjust_to_budget. Never invent places or prices.
- "Plan a trip to X", "Let's go to X", "Change destination to X" (e.g. Paris, Tokyo, London, Rome, Honolulu, Barcelona, or ANY city worldwide) → ALWAYS call change_destination tool! PICA is fully global powered by LocationIQ with NO limits or restricted destinations. You can coordinate trips to ANY city on Earth. Never say a destination is unsupported or limited; always call change_destination!
- "Adjust to my budget", "make it fit my budget", "make it cheaper so it fits", "we are over budget" → ALWAYS call adjust_to_budget tool immediately!
- "My budget is $X" → Call update_budget with the dollar amount and adjust_to_budget!
- "Remind everyone", "alert group to confirm", "nudge members to approve" → Call remind_members!
- "Summary", "itinerary", "what's the plan" → Give a concise, structured day-by-day plan with dollar shares.
- "Make X cheaper" → search the same category with a lower maxPriceCents, then replace_item with the best fit for the group's likes.
- "I don't want to do X" → set_participation(false) for the speaker. Remove the item only if nobody is left or the group agrees.
- After any change, tell the affected people their new per-person total (see COST PER PERSON or get_cost_breakdown).
- Respect likes/dislikes and flag anyone who goes over budget.
- You CANNOT approve or complete payments. request_purchase hands off to the Visa trust layer: it auto-buys within each person's
  rules or sends them an approval request. Report the tool result honestly — never say something is booked unless it is.
- Call request_purchase only when a member explicitly asks to book or buy.
- "What should we do?", "suggest something", "what's best for us" → call recommend_options and explain the top pick's reasons
  (whose likes it matches, budget fit, Visa offer). Only add it if they say yes.
- "My points", "rewards", "receipts" → call get_rewards.
- "Cancel X" for something already BOOKED → cancel_booking. Refunds go back to each member's own card.
- Tool amounts are integer cents; speak in dollars.
- Keep responses punchy, helpful, and concise.

CURRENT SPEAKER: ${input.userName} (id ${input.userId}) via ${input.channel}. ${voice}

${tripContext}`;
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const [trip, history] = await Promise.all([
    loadTripSnapshot(input.tripId),
    // The inbound message is already saved, so it's the last line of history.
    loadConversationHistory(input.tripId, config.historyLimit),
  ]);

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt(renderTripContext(trip), input) },
    ...history,
  ];

  let itineraryChanged = false;

  const sanitizeReply = (raw: string) => {
    return raw
      .replace(/^\(to\s+[^)]+\)\s*/i, "")
      .replace(/^\[[^\]]+\]\s*/i, "")
      .trim();
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await llm().chat.completions.create({
      model: config.llm.model,
      messages,
      tools: TOOL_DEFINITIONS,
      tool_choice: "auto",
    });
    const message = completion.choices[0].message;
    messages.push(message);

    if (!message.tool_calls?.length) {
      const rawText = message.content?.trim() || "Got it!";
      return { reply: sanitizeReply(rawText), itineraryChanged };
    }

    for (const call of message.tool_calls) {
      if (call.type !== "function") continue;
      let args: unknown = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        /* invalid JSON → schema validation reports it back to the model */
      }
      const result = await executeTool(call.function.name, args, { tripId: input.tripId, userId: input.userId });
      itineraryChanged ||= !!result.itineraryChanged;
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result.data) });
    }
  }

  return { reply: "Sorry, I got tangled up there — could you say that again?", itineraryChanged };
}
