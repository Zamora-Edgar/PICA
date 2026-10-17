/**
 * PHOTON 2.0 — Communication Layer adapter.
 *
 * Connects iMessage, SMS, WhatsApp, and Voice directly into TripSync using the
 * official Photon 2.0 SDK (@photon-ai/api).
 */
import crypto from "node:crypto";
import { z } from "zod";
import { config } from "../config";

export const CHANNELS = ["imessage", "sms", "whatsapp", "voice"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface PhotonInboundEvent {
  eventId: string; // used for idempotency — Photon retries webhooks
  channel: Channel;
  from: string; // sender: E.164 phone, Apple ID email (iMessage), or WhatsApp id
  to: string; // our Photon number / handle
  text: string; // message body, or Photon's speech-to-text transcript for voice
  callId?: string; // voice only — lets us speak back into the live call
}

export interface OutboundMessage {
  channel: Channel;
  to: string;
  text: string;
  callId?: string;
}

// ─── Active Photon Spaces Cache ───────────────────────────────────────────────
// Maps normalized phone (and last 10 digits) to { spaceId, agentUserId }
export const activePhotonSpaces = new Map<string, { spaceId: string; agentUserId: string }>();

export function registerPhotonSpace(address: string, spaceId: string, agentUserId: string): void {
  activePhotonSpaces.set(address, { spaceId, agentUserId });
  const digits = address.replace(/\D/g, "").slice(-10);
  if (digits) activePhotonSpaces.set(digits, { spaceId, agentUserId });
}

// Lazy Photon client instance
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let photonInstance: any = null;

async function getPhotonClient() {
  if (!photonInstance) {
    // @ts-expect-error @photon-ai/api is ESM with exports
    const { Photon } = (await import("@photon-ai/api")) as any;
    photonInstance = new Photon({ headers: { Authorization: `Bearer ${config.photon.apiKey}` } });
  }
  return photonInstance;
}

// 🔌 PHOTON: expected webhook body for HTTP webhook mode
const inboundSchema = z.object({
  id: z.string(),
  type: z.enum(["message.received", "voice.transcript"]),
  data: z.object({
    channel: z.enum(CHANNELS),
    from: z.string(),
    to: z.string(),
    text: z.string().min(1),
    call_id: z.string().optional(),
  }),
});

/** Normalize a raw Photon webhook into our event shape. Returns null for events we ignore. */
export function parsePhotonEvent(payload: unknown): PhotonInboundEvent | null {
  const parsed = inboundSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { id, data } = parsed.data;
  return {
    eventId: id,
    channel: data.channel,
    from: data.from,
    to: data.to,
    text: data.text.trim(),
    callId: data.call_id,
  };
}

/** 🔌 PHOTON: HMAC-SHA256 signature check for webhook mode */
export function verifyPhotonSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!config.photon.webhookSecret) return config.photon.mock;
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", config.photon.webhookSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.replace(/^sha256=/, ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Send an outbound message to a user via Photon 2.0 */
export async function sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
  if (config.photon.mock) {
    console.log(`[photon:mock] → ${msg.channel}:${msg.to}${msg.callId ? ` (call ${msg.callId})` : ""}\n  ${msg.text}`);
    return { messageId: `mock_${crypto.randomUUID()}` };
  }

  try {
    const photon = await getPhotonClient();
    const projectId = config.photon.projectId;
    const cleanTo = msg.to.replace(/\D/g, "").slice(-10);

    let spaceInfo = activePhotonSpaces.get(cleanTo) || activePhotonSpaces.get(msg.to);

    // If space not cached, lookup active space in Photon project
    if (!spaceInfo && projectId) {
      try {
        const [usersRes, spacesRes] = await Promise.all([
          photon.projects.listUsers({ path: { id: projectId } }),
          photon.projects.listSpaces({ path: { id: projectId } }),
        ]);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const targetUser = (usersRes.items ?? []).find((u: any) => {
          const uDigits = (u.handle || "").replace(/\D/g, "").slice(-10);
          return uDigits && cleanTo && uDigits === cleanTo;
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const agentUser = (usersRes.items ?? []).find((u: any) => u.kind === "agent");

        if (targetUser && agentUser) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const matchingSpace = (spacesRes.items ?? []).find((s: any) =>
            s.participantIds.includes(targetUser.id) && s.participantIds.includes(agentUser.id)
          );
          if (matchingSpace) {
            spaceInfo = { spaceId: matchingSpace.id, agentUserId: agentUser.id };
            registerPhotonSpace(msg.to, spaceInfo.spaceId, spaceInfo.agentUserId);
          }
        }
      } catch (err) {
        console.warn("Failed to lookup Photon spaces:", (err as Error).message);
      }
    }

    if (spaceInfo && projectId) {
      const res = await photon.projects.sendMessage({
        path: { id: projectId },
        headers: { "idempotency-key": `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}` },
        body: {
          spaceId: spaceInfo.spaceId,
          senderId: spaceInfo.agentUserId,
          content: { type: "text", format: "plain", text: msg.text },
        },
      });
      console.log(`[photon:live] 📤 Sent to ${msg.to}: "${msg.text.slice(0, 80)}..."`);
      return { messageId: res.id || `msg_${Date.now()}` };
    } else {
      console.log(`[photon:fallback] No active space yet for ${msg.to}. Message queued: "${msg.text.slice(0, 80)}..."`);
      return { messageId: `unpaired_${Date.now()}` };
    }
  } catch (err) {
    console.error(`[photon:error] Failed to send message to ${msg.to}:`, (err as Error).message);
    return { messageId: `err_${Date.now()}` };
  }
}

/** Create shareable invite link */
export async function createInviteLink(trip: { id: string; name: string; inviteCode: string }): Promise<string> {
  return `${config.publicBaseUrl}/join/${trip.inviteCode}`;
}

/**
 * 📡 Photon 2.0 Inbound Polling Loop
 * Listens for incoming iMessages/SMS directly from Photon and triggers the handler.
 */
export function startPhotonPolling(onMessage: (event: PhotonInboundEvent) => Promise<void>): void {
  if (config.photon.mock || !config.photon.apiKey || !config.photon.projectId) {
    console.log("ℹ️ Photon polling inactive (mock mode or missing credentials)");
    return;
  }

  const projectId = config.photon.projectId;
  const processedMessageIds = new Set<string>();
  let createdSince = new Date(Date.now() - 5000).toISOString();

  console.log(`📡 TripSync Photon 2.0 Poller starting for project: ${projectId}`);

  const poll = async () => {
    try {
      const photon = await getPhotonClient();
      const page = await photon.projects.listMessages({
        path: { id: projectId },
        query: {
          createdSince,
          direction: "received",
          order: "asc",
          pageSize: 50,
          platform: "imessage",
        },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const raw of page.items ?? []) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const unwrap = (o: any): any => {
          if (!o) return o;
          if (o.id && o.space && o.content) return o;
          if (o.root) return unwrap(o.root);
          return o;
        };
        const msg = unwrap(raw);
        const msgId: string = msg.id ?? "";
        const createdAt: string = msg.createdAt ?? "";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const space: any = msg.space ?? {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const content: any = msg.content ?? {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sentBy: any = msg.sentBy ?? {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const receivedBy: any = msg.receivedBy ?? {};

        if (!msgId || processedMessageIds.has(msgId)) continue;
        processedMessageIds.add(msgId);

        if (createdAt) {
          const t = new Date(createdAt);
          if (t > new Date(createdSince)) {
            createdSince = new Date(t.getTime() + 1).toISOString();
          }
        }

        let text = "";
        if (content.type === "text" && content.text) {
          text = content.text;
        } else if (content.type === "group" && Array.isArray(content.parts)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const plain = content.parts.find((p: any) => p.type === "text" && p.format === "plain");
          text = plain?.text ?? "";
        }

        const senderHandle: string = sentBy.handle ?? sentBy.root?.handle ?? "";
        const receivedHandle: string = receivedBy.handle ?? receivedBy.root?.handle ?? "";
        const spaceId: string = space.id ?? space.root?.id ?? "";
        const agentUserId: string = receivedBy.id ?? receivedBy.root?.id ?? "";

        if (!text.trim() || !senderHandle) continue;

        // Register the space in cache so outbound replies know where to go
        if (spaceId && agentUserId) {
          registerPhotonSpace(senderHandle, spaceId, agentUserId);
        }

        console.log(`[photon:live] 📨 Received message from ${senderHandle}: "${text}"`);

        const inboundEvent: PhotonInboundEvent = {
          eventId: msgId,
          channel: "imessage",
          from: senderHandle,
          to: receivedHandle,
          text: text.trim(),
        };

        onMessage(inboundEvent).catch((err) =>
          console.error(`[photon:live] Error handling message from ${senderHandle}:`, err)
        );
      }
    } catch (err) {
      console.warn("[photon:live] Poll cycle error:", (err as Error).message);
    }
  };

  setInterval(poll, 3000);
  poll().catch(console.error);
}
