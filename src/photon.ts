/**
 * photon.ts
 * Handles all Photon 2.0 Beta integration:
 *   - Polls for incoming iMessage messages using the @photon-ai/api SDK
 *   - Processes shopping list requests with Gemini + SerpAPI
 *   - Sends replies back through the Photon API
 *
 * Photon Beta dashboard: https://app.beta.photon.codes
 * Photon Beta docs:      https://photon.codes/docs/beta/get-started/imessage
 * SDK package:           @photon-ai/api
 *
 * Required .env vars:
 *   PHOTON_API_KEY        — from project Settings → API keys (starts with pho_key_)
 *   PHOTON_PROJECT_ID     — from project Settings (starts with pho_prj_)
 *   PHOTON_AGENT_HANDLE   — the phone number Photon assigned to your agent (e.g. +14155550188)
 */

import { parseShoppingList, buildReplyMessage, handleCartRequest } from "./agent";
import { fetchAllPrices } from "./prices";

// ─── Session memory: track items per conversation for "CART" follow-up ────────
const conversationMemory = new Map<
  string,
  { items: string[]; timestamp: number }
>();

// Cleanup old sessions after 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [key, val] of conversationMemory.entries()) {
    if (val.timestamp < cutoff) conversationMemory.delete(key);
  }
}, 5 * 60 * 1000);

// ─── Initialize Photon 2.0 Beta polling loop ──────────────────────────────────
export async function initPhoton(): Promise<void> {
  const apiKey = process.env.PHOTON_API_KEY;
  const projectId = process.env.PHOTON_PROJECT_ID;
  const agentHandle = process.env.PHOTON_AGENT_HANDLE;

  if (!apiKey || !projectId || !agentHandle) {
    console.warn(
      "⚠️  Photon credentials not set — running in webhook-only / demo mode.\n" +
        "   To enable real iMessage:\n" +
        "   1. Sign up at https://app.beta.photon.codes\n" +
        "   2. Create a project → Settings → copy Project ID (pho_prj_...)\n" +
        "   3. Settings → API keys → New API key → copy it (pho_key_...)\n" +
        "   4. iMessage tab → add your phone → Assign a shared number → copy it\n" +
        "   5. Set PHOTON_API_KEY, PHOTON_PROJECT_ID, PHOTON_AGENT_HANDLE in .env"
    );
    return;
  }

  try {
    // Dynamically import ESM-only @photon-ai/api
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Photon } = await import("@photon-ai/api") as any;

    const photon = new Photon({
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    console.log("📡 Photon 2.0 Beta connected — polling for iMessages...");
    console.log(`   Agent handle: ${agentHandle}`);

    // Poll for messages every 3 seconds
    const pollIntervalMs = 3000;
    // Track processed message IDs to prevent duplicate replies
    const processedMessageIds = new Set<string>();
    // Track the last message timestamp we've seen to avoid reprocessing
    let createdSince = new Date(Date.now() - 5000).toISOString();

    const pollMessages = async () => {
      try {
        const page = await photon.projects.listMessages({
          path: { id: projectId },
          query: {
            createdSince,
            direction: "received",
            order: "asc",
            pageSize: 50,
            platform: "imessage",
          },
        });

        for (const message of page.items ?? []) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const raw = message as any;

          // Photon wraps messages — recursively unwrap until we hit real fields
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const unwrap = (o: any): any => {
            if (!o) return o;
            if (o.id && o.space && o.content) return o;
            if (o.root) return unwrap(o.root);
            return o;
          };
          const msg = unwrap(raw);

          const msgId: string = msg.id ?? "";
          const createdAt: string = msg.createdAt ?? "";
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const space: any = msg.space ?? {};
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const content: any = msg.content ?? {};
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sentBy: any = msg.sentBy ?? {};
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const receivedBy: any = msg.receivedBy ?? {};

          if (!msgId || processedMessageIds.has(msgId)) continue;
          processedMessageIds.add(msgId);

          // Update polling cursor
          if (createdAt) {
            const t = new Date(createdAt);
            if (t > new Date(createdSince)) {
              createdSince = new Date(t.getTime() + 1).toISOString();
            }
          }

          // Extract text — handle flat TextContent and nested group
          let text = "";
          if (content.type === "text" && content.text) {
            text = content.text;
          } else if (content.type === "group" && Array.isArray(content.parts)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plain = content.parts.find((p: any) => p.type === "text" && p.format === "plain");
            text = plain?.text ?? "";
          }

          // Handles/IDs — handle both flat and nested UserSnapshot
          const senderHandle: string = sentBy.handle ?? sentBy.root?.handle ?? "";
          const receivedHandle: string = receivedBy.handle ?? receivedBy.root?.handle ?? "";

          // spaceId: the conversation ID we reply into
          const spaceId: string = space.id ?? space.root?.id ?? "";

          // agentUserId: the agent's user ID from receivedBy — REQUIRED by Photon sendMessage
          const agentUserId: string = receivedBy.id ?? receivedBy.root?.id ?? "";

          if (!text.trim() || !spaceId || !agentUserId) {
            console.log(`⚠️  Skipping msg — missing fields. spaceId="${spaceId}" agentUserId="${agentUserId}" text="${text}"`);
            continue;
          }

          // Only respond to messages addressed to our agent handle
          if (receivedHandle && receivedHandle !== agentHandle) continue;

          console.log(`📨 iMessage from [${senderHandle}] → [${receivedHandle}]: "${text}"`);
          console.log(`   spaceId=${spaceId}  agentUserId=${agentUserId}`);

          // Build the reply sender wrapper
          const spaceWrapper = {
            id: spaceId,
            send: async (replyText: string) => {
              try {
                await photon.projects.sendMessage({
                  path: { id: projectId },
                  headers: { "idempotency-key": `cartbot-reply:${msgId}:${Date.now()}` },
                  body: {
                    spaceId,
                    senderId: agentUserId,
                    content: { type: "text", format: "plain", text: replyText },
                  },
                });
                console.log(`📤 Replied to [${senderHandle}]`);
              } catch (err) {
                console.error("Failed to send Photon reply:", err);
              }
            },
          };

          // Process without blocking the poll loop
          processMessage(spaceWrapper, text, senderHandle || spaceId).catch(console.error);
        }
      } catch (err) {
        // Don't crash the server on transient poll errors
        console.error("⚠️  Photon poll error:", (err as Error).message);
      }
    };

    // Start polling
    setInterval(pollMessages, pollIntervalMs);
    // Also poll immediately
    await pollMessages();

  } catch (err) {
    console.warn("⚠️  Photon init failed (demo mode still active):", (err as Error).message);
  }
}

// ─── Handle incoming webhook payloads (fallback / alternative to polling) ─────
export async function handleIncomingMessage(body: Record<string, unknown>): Promise<void> {
  const messageText =
    (body.text as string) ||
    (body.message as string) ||
    (body.content as string) ||
    "";
  const senderId =
    (body.sender as string) ||
    (body.from as string) ||
    (body.space_id as string) ||
    "webhook-user";
  const spaceId = (body.space_id as string) || senderId;

  if (!messageText.trim()) return;

  console.log(`📨 Webhook [${senderId}]: "${messageText}"`);

  const mockSpace = {
    id: spaceId,
    send: async (text: string) => {
      console.log(`📤 Reply to [${senderId}]:\n${text}\n`);
      await sendReplyViaPhotonApi(spaceId, senderId, text);
    },
  };

  await processMessage(mockSpace, messageText, senderId);
}

// ─── Core message processing logic ────────────────────────────────────────────
async function processMessage(
  space: { id: string; send: (text: string) => Promise<void> },
  messageText: string,
  senderId: string
): Promise<void> {
  const text = messageText.trim();

  // ── Handle "CART" follow-up command ─────────────────────────────
  if (text.toUpperCase() === "CART") {
    const session = conversationMemory.get(senderId);
    if (session?.items.length) {
      const confirmMsg = await handleCartRequest(session.items);
      await space.send(confirmMsg);
      const cartUrl = buildWalmartCartUrl(session.items);
      await space.send(`🔗 Your Walmart cart:\n${cartUrl}`);
    } else {
      await space.send(
        "🛒 Send me your shopping list first!\n\nExample:\n\"I need milk, eggs, paper towels, and Advil\""
      );
    }
    return;
  }

  // ── Handle "HELP" command ────────────────────────────────────────
  if (text.toUpperCase() === "HELP" || text === "?") {
    await space.send(
      "🛒 CartBot — How to use:\n\n" +
        "1️⃣ Send your shopping list in plain English\n" +
        "   e.g. \"I need milk, eggs, laundry detergent\"\n\n" +
        "2️⃣ We compare prices at Walmart, Target & Amazon\n\n" +
        "3️⃣ Reply CART to auto-build your cheapest cart\n\n" +
        "Reply with a list to get started! 🛍️"
    );
    return;
  }

  // ── Acknowledge receipt ──────────────────────────────────────────
  await space.send("🔍 Searching prices... (this takes ~10 seconds)");

  try {
    // Step 1: Parse the shopping list with Gemini
    const parsed = await parseShoppingList(text);

    if (!parsed.isShoppingRequest) {
      await space.send(
        parsed.clarification ||
          "Hey! I'm CartBot 🛒 Send me a shopping list and I'll find the cheapest prices!\n\nExample: \"milk, eggs, paper towels, Advil\""
      );
      return;
    }

    if (parsed.items.length === 0) {
      await space.send(
        "🤔 I couldn't find any items in your message. Try something like:\n\"milk, eggs, bread, laundry detergent\""
      );
      return;
    }

    // Step 2: Fetch prices for all items in parallel
    const priceResults = await fetchAllPrices(parsed.items);

    // Step 3: Save session for follow-up CART command
    conversationMemory.set(senderId, {
      items: parsed.items,
      timestamp: Date.now(),
    });

    // Step 4: Build and send the SMS-friendly reply
    const reply = await buildReplyMessage(parsed.items, priceResults);
    await space.send(reply);
  } catch (err) {
    console.error("Error processing message:", err);
    await space.send(
      "😅 Something went wrong fetching prices. Please try again!\n\nReply HELP for usage tips."
    );
  }
}

// ─── Build a Walmart cart URL from item names ──────────────────────────────────
function buildWalmartCartUrl(items: string[]): string {
  const query = items.slice(0, 5).join(" ");
  return `https://www.walmart.com/search?q=${encodeURIComponent(query)}`;
}

// ─── Send a reply via Photon Beta REST API (for webhook mode) ─────────────────
async function sendReplyViaPhotonApi(
  spaceId: string,
  senderId: string,
  text: string
): Promise<void> {
  const apiKey = process.env.PHOTON_API_KEY;
  const projectId = process.env.PHOTON_PROJECT_ID;

  if (!apiKey || !projectId) return;

  try {
    const { default: axios } = await import("axios");
    await axios.post(
      `https://api.photon.codes/v1/projects/${projectId}/messages`,
      {
        spaceId,
        senderId,
        content: { type: "text", format: "plain", text },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `cartbot-webhook-reply:${Date.now()}`,
        },
      }
    );
  } catch (err) {
    console.error("Failed to send reply via Photon REST API:", err);
  }
}
