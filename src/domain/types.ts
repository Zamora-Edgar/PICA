/** Shared domain enums. SQLite has no native enums, so the DB stores these as strings. */

export const ITEM_CATEGORIES = ["LODGING", "ACTIVITY", "FOOD", "TRANSPORT"] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export type ItemStatus = "PROPOSED" | "PURCHASING" | "FINALIZING" | "PURCHASED" | "CANCELLED" | "REMOVED";
export type SplitStatus = "PENDING_APPROVAL" | "AUTHORIZED" | "CAPTURED" | "DECLINED" | "VOIDED" | "FAILED" | "REFUNDED";
export type ApprovalStatus = "PENDING" | "APPROVED" | "DECLINED" | "EXPIRED";

export function parseJsonArray(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export const formatUsd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
