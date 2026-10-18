/**
 * LocationIQ Integration for Global Destination & Place Discovery
 *
 * Uses LocationIQ Forward Geocoding and Nearby Places (POI) APIs to dynamically
 * discover real-world hotels, activities, and dining anywhere on Earth.
 */
import { config } from "../config";
import type { CatalogOption } from "../agent/catalog";
import type { ItemCategory } from "../domain/types";

export interface GeoLocation {
  name: string;
  displayName: string;
  lat: number;
  lon: number;
  country: string;
  city: string;
}

const BASE_URL = "https://us1.locationiq.com/v1";

/**
 * Geocode any global city or landmark name into coordinates
 */
export async function geocodeCity(query: string): Promise<GeoLocation | null> {
  const apiKey = config.locationiq.apiKey;
  if (!apiKey) return null;

  try {
    const url = `${BASE_URL}/search.php?key=${apiKey}&q=${encodeURIComponent(query)}&format=json&limit=1`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`LocationIQ geocode error: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    const top = data[0];
    const parts = (top.display_name || query).split(",").map((s: string) => s.trim());
    const city = parts[0] || query;
    const country = parts[parts.length - 1] || "";

    return {
      name: city,
      displayName: top.display_name,
      lat: parseFloat(top.lat),
      lon: parseFloat(top.lon),
      city,
      country,
    };
  } catch (err) {
    console.error("LocationIQ geocoding failed", err);
    return null;
  }
}

/**
 * Discover real-world places (hotels, attractions, restaurants) near coordinates
 */
export async function fetchNearbyPlaces(
  lat: number,
  lon: number,
  category: "lodging" | "activity" | "food",
  cityName: string,
): Promise<CatalogOption[]> {
  const apiKey = config.locationiq.apiKey;
  if (!apiKey) return [];

  // OpenStreetMap tags mapping
  let tag = "tourism:hotel";
  let itemCategory: ItemCategory = "LODGING";
  let basePriceCents = 60_000; // ~$200/person for 3

  if (category === "activity") {
    tag = "tourism:attraction";
    itemCategory = "ACTIVITY";
    basePriceCents = 24_000; // ~$80/person for 3
  } else if (category === "food") {
    tag = "amenity:restaurant";
    itemCategory = "FOOD";
    basePriceCents = 15_000; // ~$50/person for 3
  }

  try {
    const url = `${BASE_URL}/nearby.php?key=${apiKey}&lat=${lat}&lon=${lon}&tag=${encodeURIComponent(tag)}&radius=15000&format=json`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`LocationIQ nearby error: HTTP ${res.status}`);
      return [];
    }
    const places = await res.json();
    if (!Array.isArray(places)) return [];

    return places
      .filter((p: any) => p.name && p.name.trim().length > 2)
      .slice(0, 4)
      .map((p: any, idx: number) => {
        const id = `liq_${category}_${p.place_id || idx}_${Math.abs(Math.round(lat * 100))}`;
        const priceVariance = (idx === 0 ? 1.3 : idx === 1 ? 1.0 : idx === 2 ? 0.6 : 0.4);
        const priceCents = Math.round(basePriceCents * priceVariance);

        let desc = `${p.type || category} in ${cityName}`;
        if (p.display_name) {
          const parts = p.display_name.split(",").slice(1, 3).map((s: string) => s.trim());
          if (parts.length) desc = `${parts.join(", ")}, ${cityName}`;
        }

        return {
          id,
          destination: cityName as any,
          category: itemCategory,
          title: itemCategory === "LODGING" ? `${p.name} Suite (2 nights)` : p.name,
          merchantName: p.name,
          priceCents,
          description: desc,
          tags: [cityName.toLowerCase(), category, p.type || "travel"].filter(Boolean),
        };
      });
  } catch (err) {
    console.error("LocationIQ nearby places failed", err);
    return [];
  }
}

/**
 * Fetch a complete destination starter pack for any global city
 */
export async function discoverGlobalDestination(cityName: string): Promise<{
  location: GeoLocation;
  options: CatalogOption[];
} | null> {
  const loc = await geocodeCity(cityName);
  if (!loc) return null;

  const [lodging, activities, food] = await Promise.all([
    fetchNearbyPlaces(loc.lat, loc.lon, "lodging", loc.city),
    fetchNearbyPlaces(loc.lat, loc.lon, "activity", loc.city),
    fetchNearbyPlaces(loc.lat, loc.lon, "food", loc.city),
  ]);

  const options = [...lodging, ...activities, ...food];
  return { location: loc, options };
}
