// Slack alert hook. Slack-webhook URL is optional; if missing, alerts log
// only. We never throw from this path — alert failures must not crash the
// caller (per constitution §2.4, catch-log-continue is forbidden for
// business logic but acceptable here because alerts are a side channel).

import { request } from "undici";

import { logger } from "./logger.js";

export interface AlertOpts {
  readonly title: string;
  readonly body: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly fields?: Record<string, any>;
}

export class SlackAlerter {
  constructor(private readonly webhookUrl: string | undefined) {}

  async fire(opts: AlertOpts): Promise<void> {
    logger.error(opts.fields ?? {}, `ALERT: ${opts.title} — ${opts.body}`);
    if (!this.webhookUrl) {
      logger.warn("SLACK_WEBHOOK_URL unset; alert logged but not sent");
      return;
    }
    try {
      await request(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `*${opts.title}*\n${opts.body}\n\`\`\`${JSON.stringify(opts.fields ?? {}, null, 2)}\`\`\``,
        }),
      });
    } catch (err) {
      logger.error({ err }, "slack alert dispatch failed");
    }
  }
}
