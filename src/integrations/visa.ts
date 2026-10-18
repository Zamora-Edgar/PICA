/**
 * VISA INTELLIGENT COMMERCE — Trust & Payment Layer adapter.
 *
 * Agentic commerce principles enforced here:
 *  1. The agent never touches a card number. Users enroll a card through Visa's client-side
 *     flow and we store only an opaque, agent-scoped, revocable token reference
 *     (`User.visaAgentTokenRef`).
 *  2. Spending controls are mirrored onto that token, so Visa enforces them at authorization
 *     time too. Even if our app (or the LLM) misbehaves, out-of-policy charges are declined
 *     by the network. Our trust layer is the first gate, Visa is the second.
 *  3. Every payment carries consent evidence: the rule checks that allowed an auto-purchase,
 *     or the id of the human approval.
 *  4. Two-phase money movement: authorize (hold) each member's share, capture only once the
 *     whole group is in. If anyone declines, every hold is voided — nobody pays for a
 *     half-booked hotel.
 *
 * ⚠️ Paths and fields are placeholders — map them to the Visa Developer Center docs
 *    (search for "🔌 VISA"). Real Visa APIs use mutual TLS (client cert + key issued by the
 *    Developer Center) and, for some products, message-level encryption; configure an undici
 *    Agent with your cert and pass it as `dispatcher` in visaPost().
 */
import { randomUUID } from "node:crypto";
import { config } from "../config";

export interface ConsentEvidence {
  type: "AUTO_RULE" | "HUMAN_APPROVAL";
  approvalId?: string;
  ruleChecks: string[]; // names of the trust-layer checks that passed
}

export interface AuthorizeRequest {
  agentTokenRef: string;
  amountCents: number;
  currency: string;
  merchant: { name: string; visaMerchantId?: string | null };
  description: string;
  idempotencyKey: string; // retries must never double-charge
  consent: ConsentEvidence;
}

export type AuthorizeResult =
  | { approved: true; authorizationId: string }
  | { approved: false; declineReason: string };

export interface AgentControls {
  perTransactionMaxCents: number;
  dailyLimitCents: number | null;
  allowedCategories: string[];
  blockedMerchants: string[];
}

/** Push the user's spending rules onto their agent token so Visa enforces them too. */
export async function syncAgentControls(agentTokenRef: string, controls: AgentControls): Promise<void> {
  if (config.visa.mock) return log("controls synced", agentTokenRef, controls);

  // 🔌 VISA: set spend controls on the agent credential
  await visaPost(`/vic/v1/agent-tokens/${agentTokenRef}/controls`, {
    maxTransactionAmount: { value: controls.perTransactionMaxCents / 100, currency: "USD" },
    dailySpendLimit: controls.dailyLimitCents === null ? null : { value: controls.dailyLimitCents / 100, currency: "USD" },
    allowedCategories: controls.allowedCategories,
    blockedMerchants: controls.blockedMerchants,
  });
}

/** Phase 1: place a hold for one member's share. */
export async function authorizePayment(req: AuthorizeRequest): Promise<AuthorizeResult> {
  if (config.visa.mock) {
    log("authorize", req.agentTokenRef, req.amountCents, req.merchant.name, req.consent.type);
    return { approved: true, authorizationId: `auth_mock_${randomUUID()}` };
  }

  // 🔌 VISA: agent-initiated payment authorization using the token + consent evidence
  const res = await visaPost<{ status: string; authorizationId?: string; reason?: string }>(
    "/vic/v1/payments/authorize",
    {
      agentToken: req.agentTokenRef,
      amount: { value: req.amountCents / 100, currency: req.currency },
      merchant: req.merchant,
      description: req.description,
      consent: req.consent,
    },
    req.idempotencyKey,
  );
  return res.status === "APPROVED" && res.authorizationId
    ? { approved: true, authorizationId: res.authorizationId }
    : { approved: false, declineReason: res.reason ?? "DECLINED_BY_ISSUER" };
}

/** Phase 2a: everyone is in — settle the hold. */
export async function capturePayment(authorizationId: string, amountCents: number): Promise<void> {
  if (config.visa.mock) return log("capture", authorizationId, amountCents);
  // 🔌 VISA
  await visaPost(`/vic/v1/payments/${authorizationId}/capture`, { amount: { value: amountCents / 100 } }, `cap_${authorizationId}`);
}

/** Phase 2b: someone declined — release the hold, nothing is charged. */
export async function voidAuthorization(authorizationId: string): Promise<void> {
  if (config.visa.mock) return log("void", authorizationId);
  // 🔌 VISA
  await visaPost(`/vic/v1/payments/${authorizationId}/void`, {}, `void_${authorizationId}`);
}

/** Post-purchase: return a captured share to the card it came from (cancellation). */
export async function refundPayment(authorizationId: string, amountCents: number, reason: string): Promise<{ refundId: string }> {
  if (config.visa.mock) {
    log("refund", authorizationId, amountCents, reason);
    return { refundId: `rfnd_mock_${randomUUID()}` };
  }
  // 🔌 VISA
  return visaPost(`/vic/v1/payments/${authorizationId}/refund`, { amount: { value: amountCents / 100 }, reason }, `rfnd_${authorizationId}`);
}

/**
 * Kill switch: revoke the agent-scoped credential. After this the network declines any
 * charge PICA attempts with it, whatever our own code does. The user's real card is untouched.
 */
export async function revokeAgentToken(agentTokenRef: string): Promise<void> {
  if (config.visa.mock) return log("token revoked", agentTokenRef);
  // 🔌 VISA
  await visaPost(`/vic/v1/agent-tokens/${agentTokenRef}/revoke`, {});
}

/** A card-linked merchant offer (Visa Merchant Offers): cash back credited at settlement. */
export interface VisaOffer {
  id: string;
  merchantName: string;
  headline: string;
  cashbackPercent: number;
  maxCashbackCents: number;
  pointsMultiplier: number; // PICA points multiplier on top of the base 1 pt / $1
}

// Mock offer feed for the San Diego catalog. Merchant names must match catalog.ts.
const MOCK_OFFERS: VisaOffer[] = [
  { id: "vo_coronado_10", merchantName: "Hotel del Coronado", headline: "10% back on stays with Visa", cashbackPercent: 10, maxCashbackCents: 10_000, pointsMultiplier: 2 },
  { id: "vo_surf_15", merchantName: "San Diego Surf Academy", headline: "15% back on group lessons", cashbackPercent: 15, maxCashbackCents: 3_000, pointsMultiplier: 3 },
  { id: "vo_ptloma_5", merchantName: "Point Loma Seafoods", headline: "5% back + 2x points on dinner", cashbackPercent: 5, maxCashbackCents: 2_000, pointsMultiplier: 2 },
  { id: "vo_sail_8", merchantName: "Sail San Diego Charters", headline: "8% back on sunset sails", cashbackPercent: 8, maxCashbackCents: 2_500, pointsMultiplier: 2 },
];

/** Offers for the trip region. Cached in-process: offers change daily, not per request. */
let offerCache: VisaOffer[] | undefined;
export async function getMerchantOffers(): Promise<VisaOffer[]> {
  if (config.visa.mock) return MOCK_OFFERS;
  // 🔌 VISA: Visa Merchant Offers Resource Center (VMORC) — offers by region/merchant
  return (offerCache ??= (await visaPost<{ offers: VisaOffer[] }>("/vmorc/offers/v1/byfilter", { region: "US-CA-San Diego" })).offers);
}

async function visaPost<T = unknown>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
  const basic = Buffer.from(`${config.visa.userId}:${config.visa.password}`).toString("base64");
  const res = await fetch(`${config.visa.apiBase}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
    // dispatcher: new undici.Agent({ connect: { cert, key, ca } })  ← mTLS goes here
  });
  if (!res.ok) throw new Error(`Visa ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

function log(...args: unknown[]): void {
  console.log("[visa:mock]", ...args);
}
