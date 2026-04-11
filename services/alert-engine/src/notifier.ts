import {
  AlertSeverity,
  type AlertRecord,
} from "@airchive/types";
import type { AirchiveLogger } from "@airchive/logger";
import type { AlertEngineConfig } from "./config.js";

export class AlertNotifier {
  constructor(
    private readonly log: AirchiveLogger,
    private readonly notifications: AlertEngineConfig["notifications"],
  ) {}

  async notify(alert: AlertRecord): Promise<void> {
    if (
      alert.severity !== AlertSeverity.CRITICAL &&
      alert.severity !== AlertSeverity.EMERGENCY
    ) {
      this.log.warn(
        {
          alertId: alert.id,
          icao: alert.aircraft_icao,
          severity: alert.severity,
          type: alert.type,
        },
        alert.message,
      );
      return;
    }

    await Promise.allSettled([
      this.sendEmail(alert),
      this.sendSms(alert),
      this.sendWebhook(alert),
    ]);
  }

  async sendEmail(alert: AlertRecord): Promise<void> {
    const apiKey = this.notifications.sendgridApiKey;
    const to = this.notifications.alertEmailTo;
    if (!apiKey || !to) {
      this.log.debug(
        { alertId: alert.id },
        "SendGrid skipped: SENDGRID_API_KEY or ALERT_EMAIL_TO not set",
      );
      return;
    }

    const body = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: this.notifications.alertEmailFrom },
      subject: `[Airchive] ${alert.severity} — ${alert.type}`,
      content: [
        {
          type: "text/plain",
          value: [
            `Aircraft: ${alert.aircraft_icao}`,
            `Severity: ${alert.severity}`,
            `Type: ${alert.type}`,
            `Message: ${alert.message}`,
            `Data: ${JSON.stringify(alert.data)}`,
          ].join("\n"),
        },
      ],
    };

    this.log.info(
      { alertId: alert.id, to, provider: "sendgrid" },
      "Dispatching alert email",
    );

    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.log.error(
        { alertId: alert.id, status: res.status, body: text.slice(0, 500) },
        "SendGrid request failed",
      );
    }
  }

  async sendSms(alert: AlertRecord): Promise<void> {
    const sid = this.notifications.twilioAccountSid;
    const token = this.notifications.twilioAuthToken;
    const from = this.notifications.twilioFromNumber;
    const to = this.notifications.alertSmsTo;
    if (!sid || !token || !from || !to) {
      this.log.debug(
        { alertId: alert.id },
        "Twilio skipped: account SID, token, from number, or ALERT_SMS_TO not set",
      );
      return;
    }

    const text = `${alert.severity} ${alert.type} ${alert.aircraft_icao}: ${alert.message}`;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const form = new URLSearchParams({
      To: to,
      From: from,
      Body: text.slice(0, 1600),
    });

    this.log.info(
      { alertId: alert.id, to, provider: "twilio" },
      "Dispatching alert SMS",
    );

    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      this.log.error(
        { alertId: alert.id, status: res.status, body: errBody.slice(0, 500) },
        "Twilio request failed",
      );
    }
  }

  async sendWebhook(alert: AlertRecord): Promise<void> {
    const url = this.notifications.alertWebhookUrl;
    if (!url) {
      this.log.debug({ alertId: alert.id }, "Webhook skipped: ALERT_WEBHOOK_URL not set");
      return;
    }

    const payload = {
      id: alert.id,
      aircraft_icao: alert.aircraft_icao,
      flight_id: alert.flight_id,
      severity: alert.severity,
      type: alert.type,
      message: alert.message,
      data: alert.data,
      created_at: alert.created_at.toISOString(),
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      this.log.error(
        { alertId: alert.id, status: res.status, body: errBody.slice(0, 300) },
        "Webhook delivery failed",
      );
    }
  }
}
