/**
 * Split a total into integer-cent shares that always sum exactly to the total.
 * Leftover cents go to the first members in a stable order, so the same group
 * always gets the same shares (no flickering when the itinerary is recalculated).
 */
export function splitEvenly(totalCents: number, userIds: string[]): Map<string, number> {
  if (userIds.length === 0) return new Map();
  const ordered = [...userIds].sort();
  const base = Math.floor(totalCents / ordered.length);
  let remainder = totalCents - base * ordered.length;
  return new Map(ordered.map((id) => [id, base + (remainder-- > 0 ? 1 : 0)]));
}

/** Members who are doing (and paying for) an item: everyone minus those who opted out. */
export function participantsFor(memberIds: string[], optOutUserIds: string[]): string[] {
  const optedOut = new Set(optOutUserIds);
  return memberIds.filter((id) => !optedOut.has(id));
}
