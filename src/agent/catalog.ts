/**
 * Bookable options the agent may choose from. The LLM never invents venues or prices — it
 * can only pick catalog ids, so every price it quotes is real.
 * Curated multi-city group travel catalog for PICA (San Diego, New York, Florida).
 * Prices are group totals in cents.
 */
import type { ItemCategory } from "../domain/types";

export type DestinationCity = "San Diego" | "New York" | "Florida";

export interface CatalogOption {
  id: string;
  destination: DestinationCity;
  category: ItemCategory;
  title: string;
  merchantName: string;
  priceCents: number;
  description: string;
  tags: string[];
}

export function matchesDestination(optionDest: DestinationCity, targetDest?: string | null): boolean {
  if (!targetDest) return true;
  const t = targetDest.toLowerCase();
  const o = optionDest.toLowerCase();
  if (t.includes("san diego") || t.includes("sd") || t.includes("california")) return o === "san diego";
  if (t.includes("new york") || t.includes("nyc") || t.includes("manhattan") || t.includes("ny")) return o === "new york";
  if (t.includes("florida") || t.includes("miami") || t.includes("orlando") || t.includes("key west") || t.includes("fl")) return o === "florida";
  return o.includes(t) || t.includes(o);
}

export const CATALOG: CatalogOption[] = [
  // ─── SAN DIEGO, CA ────────────────────────────────────────────────────────
  { id: "htl_sd_coronado", destination: "San Diego", category: "LODGING", title: "Hotel del Coronado Luxury Suite (2 nights)", merchantName: "Hotel del Coronado", priceCents: 90_000, description: "Iconic oceanfront luxury villa, 2 rooms", tags: ["luxury", "beach", "views"] },
  { id: "htl_sd_gaslamp", destination: "San Diego", category: "LODGING", title: "Gaslamp Quarter Boutique Loft (2 nights)", merchantName: "Gaslamp Stays SD", priceCents: 60_000, description: "Modern downtown loft near restaurants & bay", tags: ["apartment", "downtown", "central"] },
  { id: "htl_sd_ob_surf", destination: "San Diego", category: "LODGING", title: "Ocean Beach Surf Villa private room (2 nights)", merchantName: "OB Surf Lodge", priceCents: 36_000, description: "Beachfront private suite, patio & firepit", tags: ["budget", "beach", "social"] },
  { id: "act_sd_cruisers", destination: "San Diego", category: "ACTIVITY", title: "Mission Beach & Boardwalk cruiser day", merchantName: "Mission Beach Rentals", priceCents: 8_000, description: "Bike cruisers, beach volleyball & sunset bonfire", tags: ["beach", "relaxing", "budget"] },
  { id: "act_sd_surf", destination: "San Diego", category: "ACTIVITY", title: "Pacific Beach surf coaching & boards", merchantName: "San Diego Surf Academy", priceCents: 40_000, description: "2h private group surf lesson with wetsuits & boards", tags: ["beach", "sport", "adventure"] },
  { id: "act_sd_zoo", destination: "San Diego", category: "ACTIVITY", title: "Balboa Park & San Diego Zoo Safari tour", merchantName: "San Diego Wildlife Tours", priceCents: 32_000, description: "VIP tram passes, safari park & museum entries", tags: ["wildlife", "sightseeing", "culture"] },
  { id: "act_sd_catamaran", destination: "San Diego", category: "ACTIVITY", title: "Sunset catamaran sailing on San Diego Bay", merchantName: "Sail San Diego Charters", priceCents: 24_000, description: "Private sailboat charter with drinks & skyline views", tags: ["sailing", "sunset", "views"] },
  { id: "act_sd_trolley", destination: "San Diego", category: "ACTIVITY", title: "Old Town Trolley & historic taco crawl", merchantName: "Old Town Trolley Tours", priceCents: 2_000, description: "All-day hop-on hop-off pass + walking tour", tags: ["budget", "tacos", "history"] },
  { id: "food_sd_liberty", destination: "San Diego", category: "FOOD", title: "Liberty Public Market group lunch", merchantName: "Liberty Public Market", priceCents: 12_000, description: "Artisan food hall in historic naval training center", tags: ["food", "casual", "market"] },
  { id: "food_sd_seafood", destination: "San Diego", category: "FOOD", title: "Point Loma Seafoods harbor dinner", merchantName: "Point Loma Seafoods", priceCents: 28_000, description: "Fresh local catches, harbor patio & craft beer", tags: ["food", "seafood", "craft beer"] },
  { id: "trn_sd_airport", destination: "San Diego", category: "TRANSPORT", title: "SAN Airport private sprinter transfer", merchantName: "San Diego Express Shuttle", priceCents: 6_000, description: "Private van from San Diego Int'l Airport", tags: ["transport"] },

  // ─── NEW YORK, NY ─────────────────────────────────────────────────────────
  { id: "htl_nyc_standard", destination: "New York", category: "LODGING", title: "The Standard High Line Skyline Suite (2 nights)", merchantName: "The Standard NYC", priceCents: 96_000, description: "Meatpacking views, rooftop access & Hudson panoramas", tags: ["luxury", "views", "nightlife"] },
  { id: "htl_nyc_williamsburg", destination: "New York", category: "LODGING", title: "Williamsburg Brooklyn Boutique Loft (2 nights)", merchantName: "Brooklyn Loft Stays", priceCents: 57_000, description: "Designer loft near Bedford Ave & skyline ferries", tags: ["apartment", "trendy", "central"] },
  { id: "htl_nyc_pod", destination: "New York", category: "LODGING", title: "Pod Times Square Private Quad Suite (2 nights)", merchantName: "Pod Hotels NYC", priceCents: 33_000, description: "Smart efficient hotel steps from Broadway & Midtown", tags: ["budget", "central", "social"] },
  { id: "act_nyc_broadway", destination: "New York", category: "ACTIVITY", title: "Broadway Orchestra Evening Passes", merchantName: "Broadway Box Office", priceCents: 45_000, description: "Prime orchestra seating for blockbuster Broadway musical", tags: ["broadway", "culture", "entertainment"] },
  { id: "act_nyc_centralpark", destination: "New York", category: "ACTIVITY", title: "Central Park Bike Tour & Gourmet Picnic", merchantName: "Central Park Sightseeing", priceCents: 9_000, description: "Guided scenic bike loop, Strawberry Fields & picnic basket", tags: ["park", "relaxing", "views", "budget"] },
  { id: "act_nyc_moma_rock", destination: "New York", category: "ACTIVITY", title: "MoMA & Top of the Rock VIP Passes", merchantName: "Rockefeller Center & MoMA", priceCents: 27_000, description: "Express admission to Museum of Modern Art & observation deck", tags: ["art", "views", "sightseeing"] },
  { id: "act_nyc_harbor_cruise", destination: "New York", category: "ACTIVITY", title: "Sunset Harbor Cruise past Statue of Liberty", merchantName: "Classic Harbor Line", priceCents: 21_000, description: "Champagne cruise on historic schooner with Manhattan skyline views", tags: ["sailing", "sunset", "skyline", "views"] },
  { id: "act_nyc_greenwich_walk", destination: "New York", category: "ACTIVITY", title: "Greenwich Village Historic Walking Tour", merchantName: "NYC Village Walks", priceCents: 3_000, description: "Music, literature, speakeasies & bohemian history stroll", tags: ["budget", "history", "walking"] },
  { id: "food_nyc_chelsea", destination: "New York", category: "FOOD", title: "Chelsea Market Artisan Food Tasting", merchantName: "Chelsea Market", priceCents: 13_500, description: "Tasting crawl through lobster rolls, tacos, pastries & craft cheese", tags: ["food", "casual", "market"] },
  { id: "food_nyc_little_italy", destination: "New York", category: "FOOD", title: "Carmines Little Italy Family Style Feast", merchantName: "Carmines NYC", priceCents: 24_000, description: "Legendary family-style Italian feast with pasta & sangria", tags: ["food", "dinner", "italian"] },
  { id: "trn_nyc_jfk_transfer", destination: "New York", category: "TRANSPORT", title: "JFK / LGA Private Executive Sprinter", merchantName: "NYC Airport Express", priceCents: 9_000, description: "Private Sprinter van direct to Manhattan accommodation", tags: ["transport"] },

  // ─── FLORIDA (MIAMI & KEYS) ───────────────────────────────────────────────
  { id: "htl_fl_1hotel", destination: "Florida", category: "LODGING", title: "1 Hotel South Beach Oceanfront Suite (2 nights)", merchantName: "1 Hotel South Beach", priceCents: 99_000, description: "Eco-luxury oceanfront oasis with rooftop pool & private cabana", tags: ["luxury", "beach", "pool", "views"] },
  { id: "htl_fl_brickell", destination: "Florida", category: "LODGING", title: "Brickell High-Rise Bay View Loft (2 nights)", merchantName: "Brickell Bay Suites", priceCents: 54_000, description: "Sleek 2-bedroom condo overlooking Biscayne Bay & skyline", tags: ["apartment", "downtown", "views"] },
  { id: "htl_fl_freehand", destination: "Florida", category: "LODGING", title: "Freehand Miami Beach Bungalow (2 nights)", merchantName: "Freehand Miami", priceCents: 30_000, description: "Art deco boutique rooms steps from beach with courtyard pool", tags: ["budget", "beach", "social"] },
  { id: "act_fl_catamaran", destination: "Florida", category: "ACTIVITY", title: "South Beach Private Catamaran & Sandbar Party", merchantName: "Miami Catamaran Charters", priceCents: 39_000, description: "Half-day private sail, paddleboards & Haulover sandbar stop", tags: ["beach", "sailing", "party", "adventure"] },
  { id: "act_fl_everglades", destination: "Florida", category: "ACTIVITY", title: "Everglades Airboat Safari & Wildlife Tour", merchantName: "Everglades Holiday Park", priceCents: 18_000, description: "High-speed airboat tour through glades with alligator encounter", tags: ["wildlife", "adventure", "nature"] },
  { id: "act_fl_wynwood", destination: "Florida", category: "ACTIVITY", title: "Wynwood Walls Graffiti & Street Art Tour", merchantName: "Wynwood Art Walks", priceCents: 6_000, description: "Guided tour of world-famous street art, murals & galleries", tags: ["art", "culture", "photography", "budget"] },
  { id: "act_fl_speedboat", destination: "Florida", category: "ACTIVITY", title: "Miami Vice Speedboat Thrill Tour", merchantName: "Thriller Miami", priceCents: 27_000, description: "45mph speedboat adventure past Star Island mansions & Fisher Island", tags: ["adventure", "water", "thrill"] },
  { id: "act_fl_keywest", destination: "Florida", category: "ACTIVITY", title: "Key West Coral Reef Snorkeling Day Trip", merchantName: "Florida Keys Dive Center", priceCents: 30_000, description: "Roundtrip catamaran excursion to living coral reef with gear", tags: ["snorkeling", "water", "views"] },
  { id: "food_fl_cuban", destination: "Florida", category: "FOOD", title: "Little Havana Calle Ocho Culinary Walk", merchantName: "Little Havana Food Tours", priceCents: 10_500, description: "Cuban sandwiches, croquetas, mojitos & Cuban coffee tasting", tags: ["food", "casual", "cuban"] },
  { id: "food_fl_stonecrab", destination: "Florida", category: "FOOD", title: "Joes Stone Crab Waterfront Dinner", merchantName: "Joes Stone Crab", priceCents: 33_000, description: "World-famous Florida stone crab claws & Key Lime pie", tags: ["food", "seafood", "luxury", "dinner"] },
  { id: "trn_fl_airport", destination: "Florida", category: "TRANSPORT", title: "MIA Airport Private Sprinter Shuttle", merchantName: "Miami Shuttle Express", priceCents: 7_500, description: "Private luxury van from Miami International to hotel", tags: ["transport"] },
];

// Compatibility alias for legacy IDs
const LEGACY_ID_MAP: Record<string, string> = {
  htl_alfama_boutique: "htl_sd_coronado",
  htl_belem_apartment: "htl_sd_gaslamp",
  htl_baixa_hostel: "htl_sd_ob_surf",
  act_cascais_beach: "act_sd_cruisers",
  act_surf_lesson: "act_sd_surf",
  act_sintra_tour: "act_sd_zoo",
  act_fado_night: "act_sd_catamaran",
  act_tram_walk: "act_sd_trolley",
  food_time_out: "food_sd_liberty",
  food_seafood: "food_sd_seafood",
  trn_airport: "trn_sd_airport",
};

export function searchCatalog(filter: {
  category?: ItemCategory;
  maxPriceCents?: number;
  query?: string;
  destination?: string;
}): CatalogOption[] {
  const q = filter.query?.toLowerCase();
  return CATALOG.filter(
    (o) =>
      (!filter.destination || matchesDestination(o.destination, filter.destination)) &&
      (!filter.category || o.category === filter.category) &&
      (filter.maxPriceCents === undefined || o.priceCents <= filter.maxPriceCents) &&
      (!q || `${o.title} ${o.description} ${o.tags.join(" ")}`.toLowerCase().includes(q)),
  ).sort((a, b) => a.priceCents - b.priceCents);
}

export const getCatalogOption = (id: string): CatalogOption | undefined => {
  const mappedId = LEGACY_ID_MAP[id] || id;
  return CATALOG.find((o) => o.id === mappedId);
};
