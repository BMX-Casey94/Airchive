function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseTrackedAircraft(raw: string | undefined): string[] {
  if (raw === undefined || raw === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

export interface AlertEngineConfig {
  redis: { host: string; port: number };
  trackedAircraft: string[];
  notifications: {
    sendgridApiKey: string | undefined;
    twilioAccountSid: string | undefined;
    twilioAuthToken: string | undefined;
    twilioFromNumber: string | undefined;
    alertEmailTo: string | undefined;
    alertSmsTo: string | undefined;
    alertEmailFrom: string;
    alertWebhookUrl: string | undefined;
  };
}

export function loadConfig(): AlertEngineConfig {
  return {
    redis: {
      host: process.env.REDIS_HOST ?? "127.0.0.1",
      port: envInt("REDIS_PORT", 6379),
    },
    trackedAircraft: parseTrackedAircraft(process.env.TRACKED_AIRCRAFT),
    notifications: {
      sendgridApiKey: process.env.SENDGRID_API_KEY || undefined,
      twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || undefined,
      twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || undefined,
      twilioFromNumber: process.env.TWILIO_FROM_NUMBER || undefined,
      alertEmailTo: process.env.ALERT_EMAIL_TO || undefined,
      alertSmsTo: process.env.ALERT_SMS_TO || undefined,
      alertEmailFrom:
        process.env.ALERT_EMAIL_FROM ?? "alerts@airchive.local",
      alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || undefined,
    },
  };
}
