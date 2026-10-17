/**
 * prices.ts
 * Fetches real-time product prices across Walmart, Target, Amazon, and more
 * using SerpAPI's Google Shopping endpoint.
 *
 * Free tier: 100 searches/month — perfect for a hackathon demo.
 * SerpAPI returns results from multiple stores in one query.
 */

import axios from "axios";

// ─── Types ─────────────────────────────────────────────────────────────────────
export interface StorePriceEntry {
  store: string;
  price: number;
  priceFormatted: string;
  link?: string;
  inStock: boolean;
}

export interface PriceResult {
  item: string;
  results: StorePriceEntry[];
  cheapest: StorePriceEntry | null;
  error?: string;
}

// Priority stores we care about (filter others out for cleanliness)
const PRIORITY_STORES = [
  "walmart",
  "target",
  "amazon",
  "costco",
  "kroger",
  "walgreens",
  "cvs",
  "instacart",
  "whole foods",
  "safeway",
  "aldi",
  "sam's club",
];

// ─── Fetch prices for a single item via SerpAPI ──────────────────────────────
async function fetchItemPrice(item: string): Promise<PriceResult> {
  const apiKey = process.env.SERPAPI_KEY;

  if (!apiKey) {
    console.warn("⚠️  No SERPAPI_KEY set — using mock data");
    return getMockPrice(item);
  }

  try {
    const response = await axios.get("https://serpapi.com/search.json", {
      params: {
        engine: "google_shopping",
        q: item,
        api_key: apiKey,
        num: 10,
        gl: "us", // US results
        hl: "en",
      },
      timeout: 8000,
    });

    const data = response.data;
    const shoppingResults = data.shopping_results || [];

    const storePrices: StorePriceEntry[] = [];
    const seenStores = new Set<string>();

    for (const result of shoppingResults) {
      const sourceLower = (result.source || "").toLowerCase();

      // Only include priority stores
      const matchedStore = PRIORITY_STORES.find((s) =>
        sourceLower.includes(s)
      );
      if (!matchedStore) continue;

      // De-duplicate by store (keep first/cheapest)
      const storeKey = matchedStore;
      if (seenStores.has(storeKey)) continue;
      seenStores.add(storeKey);

      // Parse price string like "$3.28" or "3.28"
      const priceRaw = result.price || "0";
      const price = parseFloat(priceRaw.replace(/[^0-9.]/g, ""));
      if (isNaN(price) || price === 0) continue;

      storePrices.push({
        store: capitalize(matchedStore),
        price,
        priceFormatted: `$${price.toFixed(2)}`,
        link: result.link || result.product_link || undefined,
        inStock: true,
      });
    }

    // Sort by price ascending
    storePrices.sort((a, b) => a.price - b.price);

    return {
      item,
      results: storePrices,
      cheapest: storePrices[0] || null,
      error: storePrices.length === 0 ? "No results found" : undefined,
    };
  } catch (err) {
    console.error(`Error fetching price for "${item}":`, err);
    return {
      item,
      results: [],
      cheapest: null,
      error: "Failed to fetch price",
    };
  }
}

// ─── Fetch prices for all items in parallel ───────────────────────────────────
export async function fetchAllPrices(items: string[]): Promise<PriceResult[]> {
  console.log(`🔍 Fetching prices for ${items.length} items...`);

  // Run all requests in parallel (SerpAPI handles rate limiting)
  const results = await Promise.all(items.map((item) => fetchItemPrice(item)));

  results.forEach((r) => {
    if (r.cheapest) {
      console.log(`  ✅ ${r.item} → cheapest at ${r.cheapest.store}: ${r.cheapest.priceFormatted}`);
    } else {
      console.log(`  ⚠️  ${r.item} → no prices found`);
    }
  });

  return results;
}

// ─── Calculate optimal store strategy ────────────────────────────────────────
export function calculateBestStrategy(results: PriceResult[]): {
  splitTotal: number;
  walmartTotal: number;
  bestSingleStore: string;
  bestSingleTotal: number;
} {
  const splitTotal = results.reduce(
    (sum, r) => sum + (r.cheapest?.price || 0),
    0
  );

  // Calculate per-store totals
  const storeTotals: Record<string, number> = {};
  for (const result of results) {
    for (const entry of result.results) {
      if (!storeTotals[entry.store]) storeTotals[entry.store] = 0;
      storeTotals[entry.store] += entry.price;
    }
  }

  const walmartTotal = storeTotals["Walmart"] || 0;

  // Find cheapest single-store option
  let bestSingleStore = "Walmart";
  let bestSingleTotal = walmartTotal;
  for (const [store, total] of Object.entries(storeTotals)) {
    if (total > 0 && total < bestSingleTotal) {
      bestSingleStore = store;
      bestSingleTotal = total;
    }
  }

  return { splitTotal, walmartTotal, bestSingleStore, bestSingleTotal };
}

// ─── Mock data for dev/demo when SerpAPI key isn't available ─────────────────
function getMockPrice(item: string): PriceResult {
  const mockStores: StorePriceEntry[] = [
    {
      store: "Walmart",
      price: +(Math.random() * 8 + 2).toFixed(2),
      priceFormatted: "",
      inStock: true,
    },
    {
      store: "Target",
      price: +(Math.random() * 8 + 2).toFixed(2),
      priceFormatted: "",
      inStock: true,
    },
    {
      store: "Amazon",
      price: +(Math.random() * 8 + 2).toFixed(2),
      priceFormatted: "",
      inStock: true,
    },
  ]
    .map((s) => ({ ...s, priceFormatted: `$${s.price.toFixed(2)}` }))
    .sort((a, b) => a.price - b.price);

  return {
    item,
    results: mockStores,
    cheapest: mockStores[0],
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function capitalize(s: string): string {
  return s
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
