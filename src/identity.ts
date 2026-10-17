/**
 * Cross-channel identity resolution — the reason context survives a channel switch.
 *
 * Photon tells us *which channel* and *which address* a message came from. We map that
 * (channel, address) pair to one User, and the User to their active Trip. The conversation
 * is stored per Trip, not per channel, so a WhatsApp text and a Photon voice call from the
 * same person land in the same thread.
 */
import { prisma } from "./db";
import type { Channel } from "./integrations/photon";

/** "whatsapp:+1 (555) 123-4567" → "+15551234567"; Apple ID emails are lowercased. */
export function normalizeAddress(raw: string): string {
  const value = raw.trim().replace(/^(whatsapp|sms|tel|imessage):/i, "");
  if (value.includes("@")) return value.toLowerCase();
  const digits = value.replace(/[^\d]/g, "");
  return `+${digits}`;
}

export async function resolveUser(channel: Channel, rawAddress: string) {
  const address = normalizeAddress(rawAddress);

  const identity = await prisma.channelIdentity.findUnique({
    where: { channel_address: { channel, address } },
    include: { user: true },
  });
  if (identity) return identity.user;

  // Same phone number on a channel we haven't seen yet (e.g. first voice call):
  // auto-link it so the user never has to "re-register" per channel.
  if (!address.includes("@")) {
    const user = await prisma.user.findUnique({ where: { phoneE164: address } });
    if (user) {
      await prisma.channelIdentity.create({ data: { userId: user.id, channel, address } });
      return user;
    }
  }
  return null;
}

/** On join, register the user's phone on every phone-based channel (+ iMessage email if given). */
export async function linkDefaultIdentities(userId: string, phoneE164: string, email?: string | null) {
  const pairs: { channel: Channel; address: string }[] = [
    { channel: "sms", address: phoneE164 },
    { channel: "whatsapp", address: phoneE164 },
    { channel: "voice", address: phoneE164 },
    { channel: "imessage", address: phoneE164 },
  ];
  if (email) pairs.push({ channel: "imessage", address: email.toLowerCase() });

  for (const { channel, address } of pairs) {
    await prisma.channelIdentity.upsert({
      where: { channel_address: { channel, address } },
      create: { userId, channel, address },
      update: { userId },
    });
  }
}

/** The trip a message belongs to: the user's most recently joined trip that's still being planned. */
export async function resolveActiveTrip(userId: string) {
  const membership = await prisma.tripMember.findFirst({
    where: { userId, trip: { status: { in: ["PLANNING", "BOOKING"] } } },
    orderBy: { joinedAt: "desc" },
    include: { trip: true },
  });
  return membership?.trip ?? null;
}
