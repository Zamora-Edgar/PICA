/**
 * Bookable options the agent may choose from. The LLM never invents venues or prices — it
 * can only pick catalog ids, so every price it quotes is real.
 * Curated San Diego group travel catalog for PICA. Prices are group totals in cents.
 */
import type { ItemCategory } from "../domain/types";

export interface CatalogOption {
  id: string;
  category: ItemCategory;
  title: string;
  merchantName: string;
  priceCents: number;
  description: string;
  tags: string[];
}

export const CATALOG: CatalogOption[] = [
  { id: "htl_alfama_boutique", category: "LODGING", title: "Hotel del Coronado Luxury Suite (2 nights)", merchantName: "Hotel del Coronado", priceCents: 90_000, description: "Iconic oceanfront luxury villa, 2 rooms", tags: ["luxury", "beach", "views"] },
  { id: "htl_belem_apartment", category: "LODGING", title: "Gaslamp Quarter Boutique Loft (2 nights)", merchantName: "Gaslamp Stays SD", priceCents: 60_000, description: "Modern downtown loft near restaurants & bay", tags: ["apartment", "downtown", "central"] },
  { id: "htl_baixa_hostel", category: "LODGING", title: "Ocean Beach Surf Villa private room (2 nights)", merchantName: "OB Surf Lodge", priceCents: 36_000, description: "Beachfront private suite, patio & firepit", tags: ["budget", "beach", "social"] },
  { id: "act_cascais_beach", category: "ACTIVITY", title: "Mission Beach & Boardwalk cruiser day", merchantName: "Mission Beach Rentals", priceCents: 8_000, description: "Bike cruisers, beach volleyball & sunset bonfire", tags: ["beach", "relaxing", "budget"] },
  { id: "act_surf_lesson", category: "ACTIVITY", title: "Pacific Beach surf coaching & boards", merchantName: "San Diego Surf Academy", priceCents: 40_000, description: "2h private group surf lesson with wetsuits & boards", tags: ["beach", "sport", "adventure"] },
  { id: "act_sintra_tour", category: "ACTIVITY", title: "Balboa Park & San Diego Zoo Safari tour", merchantName: "San Diego Wildlife Tours", priceCents: 32_000, description: "VIP tram passes, safari park & museum entries", tags: ["wildlife", "sightseeing", "culture"] },
  { id: "act_fado_night", category: "ACTIVITY", title: "Sunset catamaran sailing on San Diego Bay", merchantName: "Sail San Diego Charters", priceCents: 24_000, description: "Private sailboat charter with drinks & skyline views", tags: ["sailing", "sunset", "views"] },
  { id: "act_tram_walk", category: "ACTIVITY", title: "Old Town Trolley & historic taco crawl", merchantName: "Old Town Trolley Tours", priceCents: 2_000, description: "All-day hop-on hop-off pass + walking tour", tags: ["budget", "tacos", "history"] },
  { id: "food_time_out", category: "FOOD", title: "Liberty Public Market group lunch", merchantName: "Liberty Public Market", priceCents: 12_000, description: "Artisan food hall in historic naval training center", tags: ["food", "casual", "market"] },
  { id: "food_seafood", category: "FOOD", title: "Point Loma Seafoods harbor dinner", merchantName: "Point Loma Seafoods", priceCents: 28_000, description: "Fresh local catches, harbor patio & craft beer", tags: ["food", "seafood", "craft beer"] },
  { id: "trn_airport", category: "TRANSPORT", title: "SAN Airport private sprinter transfer", merchantName: "San Diego Express Shuttle", priceCents: 6_000, description: "Private van from San Diego Int'l Airport", tags: ["transport"] },
];

export function searchCatalog(filter: { category?: ItemCategory; maxPriceCents?: number; query?: string }): CatalogOption[] {
  const q = filter.query?.toLowerCase();
  return CATALOG.filter(
    (o) =>
      (!filter.category || o.category === filter.category) &&
      (filter.maxPriceCents === undefined || o.priceCents <= filter.maxPriceCents) &&
      (!q || `${o.title} ${o.description} ${o.tags.join(" ")}`.toLowerCase().includes(q)),
  ).sort((a, b) => a.priceCents - b.priceCents);
}

export const getCatalogOption = (id: string) => CATALOG.find((o) => o.id === id);

