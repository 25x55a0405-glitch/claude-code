import webpush, { type PushSubscription } from 'web-push';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import type { PushSubscriptionInfo } from './types.ts';
import { badRequest, iso, notFound, uid } from './util.ts';

export interface PushMessage {
  title: string;
  body: string;
  /** Opened when the notification is tapped, relative to the web app (a hash route, e.g. "#/tasks/t_1"). */
  url?: string;
  /** Notifications with the same tag replace each other. */
  tag?: string;
  urgent?: boolean;
}

/**
 * Notifications to the person's devices, on free infrastructure:
 *  - Web Push with the server's own VAPID keys (made on first use). Works in
 *    Chrome, Edge and Firefox, and on iPhone once Sky is added to the home screen.
 *  - ntfy (ntfy.sh or a self-hosted server): subscribe to a topic in the ntfy app.
 */
export class Push {
  store: Store;
  config: Config;
  fetch: () => typeof fetch;
  /** The Web Push sender; tests swap it out. */
  sendWebPush: typeof webpush.sendNotification = (...args) => webpush.sendNotification(...args);

  constructor(store: Store, config: Config, fetchFn: () => typeof fetch) {
    this.store = store;
    this.config = config;
    this.fetch = fetchFn;
  }

  private vapid(): { publicKey: string; privateKey: string } {
    let keys = this.store.db.getKv<{ publicKey: string; privateKey: string }>('vapid');
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      this.store.db.setKv('vapid', keys);
    }
    return keys;
  }

  /** The public key the browser needs for pushManager.subscribe (applicationServerKey). */
  publicKey(): string {
    return this.vapid().publicKey;
  }

  list(): PushSubscriptionInfo[] {
    return this.store.db.all<PushSubscriptionInfo>('push').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  subscribe(sub: unknown, label: string): PushSubscriptionInfo {
    const s = sub as PushSubscription;
    if (!s || typeof s.endpoint !== 'string' || !/^https?:\/\//.test(s.endpoint) || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') {
      throw badRequest('subscription must be the object from pushManager.subscribe(), with endpoint and keys');
    }
    // The same device subscribing again replaces its old entry.
    for (const existing of this.list()) {
      if (this.store.db.getPrivate<PushSubscription>('push', existing.id)?.endpoint === s.endpoint) this.store.db.delete('push', existing.id);
    }
    const info = this.store.db.put<PushSubscriptionInfo>('push', { id: uid('push'), label, createdAt: iso(), lastSentAt: null });
    this.store.db.setPrivate('push', info.id, { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
    return info;
  }

  remove(id: string) {
    if (!this.store.db.delete('push', id)) throw notFound('Push subscription', id);
  }

  /** Sends to every subscribed device and to ntfy, if set. Returns where it went. */
  async send(msg: PushMessage): Promise<{ delivered: string[]; failed: string[] }> {
    const settings = this.store.settings();
    const delivered: string[] = [];
    const failed: string[] = [];
    const jobs: Promise<void>[] = [];

    if (settings.channels.push) {
      const { publicKey, privateKey } = this.vapid();
      const subject = this.config.publicUrl.startsWith('https://') ? this.config.publicUrl : 'mailto:sky@localhost';
      const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url ?? '#/', tag: msg.tag });
      for (const info of this.list()) {
        const sub = this.store.db.getPrivate<PushSubscription>('push', info.id);
        if (!sub) continue;
        jobs.push(this.sendWebPush(sub, payload, {
          vapidDetails: { subject, publicKey, privateKey }, TTL: 24 * 3600, timeout: 15_000, urgency: msg.urgent ? 'high' : 'normal', ...(msg.tag ? { topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
        }).then(() => {
          delivered.push(info.label);
          this.store.db.put('push', { ...info, lastSentAt: iso() });
        }).catch((err: { statusCode?: number; message?: string }) => {
          // Gone: the browser dropped the subscription, so forget it.
          if (err.statusCode === 404 || err.statusCode === 410) this.store.db.delete('push', info.id);
          failed.push(`${info.label}: ${err.statusCode ?? err.message}`);
        }));
      }
    }

    if (settings.ntfyTopic) {
      const server = (settings.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '');
      jobs.push(this.fetch()(`${server}/${encodeURIComponent(settings.ntfyTopic)}`, {
        method: 'POST',
        headers: {
          Title: asciiHeader(msg.title), Tags: 'star', Priority: msg.urgent ? 'high' : 'default',
          ...(msg.url && /^https?:/.test(this.config.webUrl) ? { Click: `${this.config.webUrl}/${msg.url.replace(/^\//, '')}` } : {}),
        },
        body: msg.body,
      }).then((res) => {
        if (!res.ok) throw new Error(`ntfy ${res.status}`);
        delivered.push('ntfy');
      }).catch((err: Error) => { failed.push(`ntfy: ${err.message}`); }));
    }

    await Promise.all(jobs);
    return { delivered, failed };
  }
}

/** HTTP headers must be plain ASCII; ntfy shows the title as given. */
const asciiHeader = (s: string) => s.replace(/[’‘]/g, '\'').replace(/[“”]/g, '"').replace(/[^\x20-\x7E]/g, '').slice(0, 200);
