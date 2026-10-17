/**
 * PHOTON 2.0 — Communication Layer adapter.
 *
 * Every channel (iMessage, SMS, WhatsApp, Voice) enters and leaves TripSync through this file.
 * The rest of the app only sees a normalized `PhotonInboundEvent` and calls `sendMessage()`,
 * so adapting to Photon's exact payload shape or adding a channel is a one-file change.
 *
 * ⚠️ Endpoint paths and payload field names are placeholders modeled on a typical messaging
 *    API. Replace them with the ones in the Photon 2.0 docs — search for "🔌 PHOTON".
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

// 🔌 PHOTON: expected webhook body. Adjust field names to match Photon 2.0's payload.
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
  if (!parsed.success) return null; // delivery receipts, typing indicators, call status, etc.
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

/** 🔌 PHOTON: HMAC-SHA256 over the raw request body. Header name/format are assumptions. */
export function verifyPhotonSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!config.photon.webhookSecret) return config.photon.mock; // unsigned allowed only in local mock mode
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", config.photon.webhookSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.replace(/^sha256=/, ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Send a reply on the user's native channel. Voice replies are spoken via TTS. */
export async function sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
  if (config.photon.mock) {
    console.log(`[photon:mock] → ${msg.channel}:${msg.to}${msg.callId ? ` (call ${msg.callId})` : ""}\n  ${msg.text}`);
    return { messageId: `mock_${crypto.randomUUID()}` };
  }

  if (msg.channel === "voice") {
    // 🔌 PHOTON VOICE: speak into the live call if there is one, otherwise place an outbound call
    // (used for approval requests to users whose preferred channel is voice).
    return msg.callId
      ? photonPost(`/calls/${msg.callId}/say`, { text: msg.text })
      : photonPost("/calls", { from: config.photon.voiceNumber, to: msg.to, say: msg.text, gather: "speech" });
  }

  // 🔌 PHOTON MESSAGING: one endpoint for iMessage / SMS / WhatsApp — Photon routes by `channel`.
  return photonPost("/messages", { channel: msg.channel, to: msg.to, text: msg.text });
}

/** Create the shareable invite link the organizer sends to friends. */
export async function createInviteLink(trip: { id: string; name: string; inviteCode: string }): Promise<string> {
  const joinUrl = `${config.publicBaseUrl}/join/${trip.inviteCode}`;
  if (config.photon.mock) return joinUrl;

  // 🔌 PHOTON LINKS: a trackable short link that deep-links into the join flow.
  const res = await photonPost<{ url: string }>("/links", {
    destination: joinUrl,
    title: `Join ${trip.name} on TripSync`,
    metadata: { tripId: trip.id },
  });
  return res.url;
}

async function photonPost<T = { messageId: string }>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${config.photon.apiBase}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.photon.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Photon ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
