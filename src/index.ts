import dotenv from "dotenv";
dotenv.config();

import path from "path";
import express from "express";
import cors from "cors";
import { handleIncomingMessage } from "./photon";
import { initPhoton } from "./photon";
import { parseShoppingList, buildReplyMessage } from "./agent";
import { fetchAllPrices } from "./prices";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Serve static demo dashboard ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "../public")));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "CartBot is live 🛒" });
});

// ─── Live Demo Endpoint (powers the web UI demo) ──────────────────────────────
app.post("/demo", async (req, res) => {
  try {
    const { message } = req.body as { message: string };
    if (!message) {
      res.status(400).json({ error: "No message provided" });
      return;
    }

    const parsed = await parseShoppingList(message);

    if (!parsed.isShoppingRequest) {
      res.json({ reply: parsed.clarification || "Send me a shopping list!" });
      return;
    }

    const priceResults = await fetchAllPrices(parsed.items);
    const reply = await buildReplyMessage(parsed.items, priceResults);

    res.json({ reply, items: parsed.items, prices: priceResults });
  } catch (err) {
    console.error("Demo error:", err);
    res.status(500).json({ error: "Failed to process request" });
  }
});

// ─── Photon Webhook (receives incoming iMessage/SMS/WhatsApp messages) ────────
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    console.log("📩 Incoming webhook:", JSON.stringify(body, null, 2));
    await handleIncomingMessage(body);
    res.json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
const server = app.listen(PORT, async () => {
  console.log(`\n🛒 CartBot server running!`);
  console.log(`   Dashboard:  http://localhost:${PORT}`);
  console.log(`   Webhook:    http://localhost:${PORT}/webhook`);
  console.log(`   Demo API:   http://localhost:${PORT}/demo`);
  console.log(`\n💡 Next step: run "npm run tunnel" in a new terminal to expose your webhook\n`);

  // Start the Photon streaming listener (for real-time push messages)
  await initPhoton();
});

export default server;
