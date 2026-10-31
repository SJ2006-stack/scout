import type { AgentId } from "../../shared/hosts.ts";
import type { FcmSender } from "./fcm.ts";
import type { InboxItem, InboxStore } from "./inbox.ts";

export type Notice = { agent: AgentId; kind: string; title: string; body: string; url: string | null };
export type Delivery = { item: InboxItem; pushed: number };

export class Notifier {
  private readonly inbox: InboxStore;
  private readonly push: FcmSender | null;
  private readonly now: () => number;

  constructor(inbox: InboxStore, push: FcmSender | null, now: () => number) {
    this.inbox = inbox;
    this.push = push;
    this.now = now;
  }

  async notify(userId: string, notice: Notice): Promise<Delivery> {
    const item = this.inbox.add(userId, notice, this.now());
    if (!this.push) return { item, pushed: 0 };
    let pushed = 0;
    for (const device of this.inbox.devices(userId)) {
      const result = await this.push.send(device.pushToken, { id: item.id, type: notice.kind, title: notice.title, body: notice.body, url: notice.url });
      if (result === "sent") pushed += 1;
      if (result === "unregistered") this.inbox.dropToken(device.pushToken);
    }
    return { item, pushed };
  }
}
