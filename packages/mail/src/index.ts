import nodemailer from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type MailConfig =
  | { driver: "log"; from: string }
  | { driver: "smtp"; from: string; url: string }
  | { driver: "resend"; from: string; apiKey: string };

const DEFAULT_LOG_FROM = "Atlas <no-reply@localhost>";

/** Parses configuration without including credentials in validation errors. */
export function parseMailConfig(env: { MAIL_URL?: string; MAIL_FROM?: string }): MailConfig {
  const value = env.MAIL_URL?.trim() || "log://";
  const from = env.MAIL_FROM?.trim();

  if (value === "log://") {
    return { driver: "log", from: from || DEFAULT_LOG_FROM };
  }

  if (!from) {
    throw new Error("MAIL_FROM is required when MAIL_URL sends email");
  }

  if (value.startsWith("resend://")) {
    const apiKey = value.slice("resend://".length);
    if (!apiKey || /[\s/?#@]/.test(apiKey)) {
      throw new Error("MAIL_URL must contain a Resend API key after resend://");
    }
    return { driver: "resend", from, apiKey };
  }

  if (value.startsWith("smtp://") || value.startsWith("smtps://")) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("MAIL_URL must be a valid SMTP URL");
    }
    if (!url.hostname || !url.username || !url.password || url.search || url.hash) {
      throw new Error("MAIL_URL must contain SMTP credentials and a host, without query or fragment");
    }
    return { driver: "smtp", from, url: value };
  }

  throw new Error("MAIL_URL must use log://, smtp://, smtps://, or resend://");
}

function validateMessage(message: MailMessage): void {
  if (!message.to?.trim() || !message.subject?.trim()) {
    throw new Error("Mail recipient and subject are required");
  }
  if (!message.html?.trim() && !message.text?.trim()) {
    throw new Error("Mail html or text body is required");
  }
}

/** Send mail using MAIL_URL and MAIL_FROM from the process environment. */
export async function sendMail(message: MailMessage): Promise<void> {
  validateMessage(message);
  const config = parseMailConfig({ MAIL_URL: process.env.MAIL_URL, MAIL_FROM: process.env.MAIL_FROM });

  if (config.driver === "log") {
    console.info("[mail]", { from: config.from, ...message });
    return;
  }

  if (config.driver === "smtp") {
    await nodemailer.createTransport(config.url).sendMail({ from: config.from, ...message });
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: config.from, ...message }),
  });
  if (!response.ok) {
    throw new Error(`Resend rejected email (${response.status})`);
  }
}
export * from "./push.js";
