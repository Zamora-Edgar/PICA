# 🛒 CartBot — LA Hacks 2026 Setup Guide

> **AI-powered SMS/iMessage shopping assistant that finds the cheapest prices across Walmart, Target & Amazon**

---

## ⚡ Quick Start (TL;DR)

```bash
cp .env.example .env   # fill in your API keys
npm run dev            # start the server
npm run tunnel         # expose to internet (new terminal)
```

---

## 📁 Project Structure

```
cartbot/
├── src/
│   ├── index.ts       ← Express server + routes
│   ├── agent.ts       ← Gemini LLM (parse list, format reply)
│   ├── prices.ts      ← SerpAPI price fetching
│   └── photon.ts      ← Photon 2.0 messaging integration
├── public/
│   └── index.html     ← Demo dashboard (shown to judges!)
├── .env.example       ← Copy to .env and fill in keys
└── package.json
```

---

## 🔑 API Keys You Need (All Free!)

### 1. Google Gemini API — *5 minutes*
> Used to parse shopping lists from natural language

1. Go to → **https://aistudio.google.com/apikey**
2. Click **"Create API Key"**
3. Copy the key → paste into `.env` as `GEMINI_API_KEY`

✅ Free tier: 60 requests/minute — more than enough for a hackathon

---

### 2. SerpAPI — *5 minutes*
> Used to get real-time prices from Google Shopping (Walmart, Target, Amazon, etc.)

1. Go to → **https://serpapi.com**
2. Sign up (free tier gives **100 searches/month**)
3. Find your API key in the dashboard
4. Copy → paste into `.env` as `SERPAPI_KEY`

💡 **Demo tip:** If you run out, the code automatically falls back to mock data — so your demo still works!

---

### 3. Photon 2.0 — *10 minutes (get credentials at their sponsor table!)*
> Used to send/receive iMessage, SMS, WhatsApp messages

1. Go to their **sponsor table at LA Hacks** and ask for hackathon credentials
2. Or sign up at → **https://photon.codes**
3. Create a project and copy:
   - `Project ID` → `PHOTON_PROJECT_ID`
   - `Project Secret` → `PHOTON_PROJECT_SECRET`
4. Set your webhook URL to your tunnel URL + `/webhook`
   - Example: `https://your-tunnel-url.loca.lt/webhook`

---

## 🚀 Running the Project

### Step 1: Set up your `.env`
```bash
cp .env.example .env
# Open .env and fill in all 3 API keys
```

### Step 2: Start the dev server
```bash
npm run dev
```
You should see:
```
🛒 CartBot server running!
   Dashboard:  http://localhost:3000
   Webhook:    http://localhost:3000/webhook
   Demo API:   http://localhost:3000/demo
```

### Step 3: Expose your webhook (new terminal)
```bash
npm run tunnel
# This gives you a public URL like: https://spotty-fox-21.loca.lt
```

### Step 4: Register webhook with Photon
- Copy your tunnel URL (e.g. `https://spotty-fox-21.loca.lt`)
- Go to Photon dashboard → set webhook to `<your-url>/webhook`

### Step 5: Test it!
- **Web demo:** Open `http://localhost:3000` in your browser
- **Real SMS:** Text your shopping list to the Photon number they give you
- **Direct API test:**
  ```bash
  curl -X POST http://localhost:3000/demo \
    -H "Content-Type: application/json" \
    -d '{"message": "milk, eggs, paper towels, Advil"}'
  ```

---

## 🧪 Testing Without API Keys

The server works even without Photon keys (webhook mode) and even without SerpAPI (mock prices). You can demo the full flow on the web dashboard at `http://localhost:3000`.

Test commands you can send:
- `milk, eggs, paper towels, laundry detergent`
- `I need advil, shampoo, coffee, and bananas`
- `toilet paper, olive oil, frozen pizza, orange juice`
- `CART` (after a shopping list — builds your Walmart cart link)
- `HELP` (shows usage instructions)

---

## 🏆 Prize Strategy

| Prize | How We Qualify |
|---|---|
| **Photon** — Messaging Agent | Core delivery channel (iMessage/SMS) |
| **Visa** — Future of Shopping | Frictionless AI commerce experience |
| **Applied Intelligence** | Real-world AI solving everyday savings |
| **MLH Best Use of Gemini** | Gemini does all NLP parsing |
| **Browser Use** | Auto-cart building (stretch goal) |
| **Paper** — Best Designed Hack | The dashboard is 🔥 |

---

## 🔧 Extending the Project (Stretch Goals)

### Add Browser Use for real cart automation
```bash
pip install browser-use
```
Then call it from `photon.ts` when user replies "CART" to actually auto-checkout.

### Add ElevenLabs voice confirmation
```bash
npm install elevenlabs
```
When cart is built, call the user back with a voice summary of their savings.

### Add more stores
In `prices.ts`, add more store names to the `PRIORITY_STORES` array:
```typescript
"trader joe's", "publix", "heb", "meijer", "dollar general"
```

### Add Fetch.ai agent registration
Register CartBot on Agentverse to qualify for the Fetch.ai/ASI:One challenge too.

---

## ❓ Troubleshooting

**`spectrum-ts` import errors:**
→ Photon's package may have a different name. Check their docs at the sponsor table and update the import in `photon.ts`.

**SerpAPI rate limits:**
→ Mock data kicks in automatically. The demo still works!

**Tunnel disconnects:**
→ Just re-run `npm run tunnel` and update the webhook URL in Photon.

**TypeScript errors:**
→ Run `npx tsc --noEmit` to check. Most are just missing type annotations, safe to ignore with `// @ts-ignore` for the hackathon.

---

*Built at LA Hacks 2026 — 36 hours, infinite caffeine ⚡*
