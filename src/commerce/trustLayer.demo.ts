/**
 * Run: npm run demo:trust
 * The pitch scenario: a $600 hotel split four ways ($150/person), evaluated against four
 * different people's Visa spending rules.
 */
import { splitEvenly } from "./splits";
import { DEFAULT_POLICY, evaluatePurchase, type SpendingPolicy, type SpendContext } from "./trustLayer";

const hotel = { totalCents: 60_000, category: "LODGING" as const, merchantName: "Alfama Boutique Hotel" };

const people: { name: string; policy: SpendingPolicy; ctx: SpendContext }[] = [
  {
    name: "Ana (auto-buy up to $200)",
    policy: { ...DEFAULT_POLICY, autoApproveLimitCents: 20_000 },
    ctx: { hasAgentToken: true, tripBudgetCents: 80_000, spentOnTripCents: 10_000, spentTodayCents: 0 },
  },
  {
    name: "Ben (auto-buy up to $100)",
    policy: { ...DEFAULT_POLICY, autoApproveLimitCents: 10_000 },
    ctx: { hasAgentToken: true, tripBudgetCents: 50_000, spentOnTripCents: 0, spentTodayCents: 0 },
  },
  {
    name: "Cara (hard cap $120/purchase)",
    policy: { ...DEFAULT_POLICY, autoApproveLimitCents: 20_000, perTransactionMaxCents: 12_000 },
    ctx: { hasAgentToken: true, tripBudgetCents: null, spentOnTripCents: 0, spentTodayCents: 0 },
  },
  {
    name: "Dev (no card linked, default rules)",
    policy: DEFAULT_POLICY,
    ctx: { hasAgentToken: false, tripBudgetCents: 40_000, spentOnTripCents: 30_000, spentTodayCents: 0 },
  },
];

const shares = splitEvenly(hotel.totalCents, people.map((p) => p.name));
for (const person of people) {
  const amountCents = shares.get(person.name)!;
  const decision = evaluatePurchase({ ...hotel, amountCents }, person.policy, person.ctx);
  console.log(`\n${person.name} — share $${(amountCents / 100).toFixed(2)}`);
  console.log(`  → ${decision.action}: ${decision.summary}`);
}
