/**
 * Bookable options the agent may choose from. The LLM never invents venues or prices — it
 * can only pick catalog ids, so every price it quotes is real.
 * For the MVP this is a static Lisbon catalog; in production swap searchCatalog() for a
 * hotel/activity inventory API. Prices are group totals in cents.
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
  { id: "htl_alfama_boutique", category: "LODGING", title: "Alfama Boutique Hotel (3 nights)", merchantName: "Alfama Boutique Hotel", priceCents: 90_000, description: "Rooftop views, central, 2 rooms", tags: ["central", "boutique", "views"] },
  { id: "htl_belem_apartment", category: "LODGING", title: "Belém Riverside Apartment (3 nights)", merchantName: "Belém Stays", priceCents: 60_000, description: "4-bed apartment by the river", tags: ["apartment", "quiet", "river"] },
  { id: "htl_baixa_hostel", category: "LODGING", title: "Baixa Social Hostel private room (3 nights)", merchantName: "Baixa Social Hostel", priceCents: 36_000, description: "Private 4-person room, social bar", tags: ["budget", "social", "central"] },
  { id: "act_cascais_beach", category: "ACTIVITY", title: "Cascais beach day + train", merchantName: "CP Comboios", priceCents: 8_000, description: "Train to Cascais, beach clubs", tags: ["beach", "relaxing"] },
  { id: "act_surf_lesson", category: "ACTIVITY", title: "Costa da Caparica surf lesson", merchantName: "Caparica Surf School", priceCents: 40_000, description: "2h group lesson, boards included", tags: ["beach", "sport", "adventure"] },
  { id: "act_sintra_tour", category: "ACTIVITY", title: "Sintra palaces day tour", merchantName: "Sintra Tours Lda", priceCents: 32_000, description: "Pena Palace + Quinta da Regaleira", tags: ["history", "hiking", "culture"] },
  { id: "act_fado_night", category: "ACTIVITY", title: "Fado dinner show in Alfama", merchantName: "Clube de Fado", priceCents: 24_000, description: "Traditional music + dinner", tags: ["music", "nightlife", "culture"] },
  { id: "act_tram_walk", category: "ACTIVITY", title: "Tram 28 + free walking tour", merchantName: "Carris", priceCents: 2_000, description: "Day passes and a tip-based walking tour", tags: ["budget", "culture"] },
  { id: "food_time_out", category: "FOOD", title: "Time Out Market group lunch", merchantName: "Time Out Market Lisboa", priceCents: 12_000, description: "Food hall, something for everyone", tags: ["food", "casual"] },
  { id: "food_seafood", category: "FOOD", title: "Cervejaria Ramiro seafood dinner", merchantName: "Cervejaria Ramiro", priceCents: 28_000, description: "Famous seafood house", tags: ["food", "seafood"] },
  { id: "trn_airport", category: "TRANSPORT", title: "Airport transfer (van)", merchantName: "Lisbon Transfers", priceCents: 6_000, description: "Private van for the group", tags: ["transport"] },
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
