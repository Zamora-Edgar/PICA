/**
 * Outbound messaging helpers. Everything we send is also written to the trip's Message
 * timeline, so the agent sees approvals, booking confirmations, and broadcasts as part of
 * the same conversation — whichever channel they went out on.
 */
import { prisma } from "./db";
import { sendMessage, type Channel } from "./integrations/photon";

/** Message one user on their preferred channel (falls back to SMS). */
export async function notifyUser(userId: string, text: string, tripId?: string): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { identities: true } });
  const identity =
    user.identities.find((i) => i.channel === user.preferredChannel) ??
    user.identities.find((i) => i.channel === "sms");
  if (!identity) {
    console.warn(`No reachable channel for user ${userId}`);
    return;
  }

  await sendMessage({ channel: identity.channel as Channel, to: identity.address, text });
  await prisma.message.create({
    data: { tripId, userId, channel: identity.channel, direction: "OUTBOUND", body: text },
  });
}

/**
 * Message every member of a trip, each on their own preferred channel. This is the
 * "unified group chat": iMessage, WhatsApp and SMS users can't share one native group,
 * so Photon fans out per person while our Message table keeps one shared thread.
 */
export async function notifyTrip(tripId: string, text: string, exceptUserId?: string): Promise<void> {
  const members = await prisma.tripMember.findMany({ where: { tripId } });
  const results = await Promise.allSettled(
    members.filter((m) => m.userId !== exceptUserId).map((m) => notifyUser(m.userId, text, tripId)),
  );
  results.forEach((r) => r.status === "rejected" && console.error("notifyTrip failed:", r.reason));
}
