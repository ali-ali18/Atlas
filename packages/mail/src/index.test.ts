import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMailConfig, sendMail } from "./index.js";

const { sendSmtpMail, createTransport } = vi.hoisted(() => {
  const sendSmtpMail = vi.fn();
  return { sendSmtpMail, createTransport: vi.fn(() => ({ sendMail: sendSmtpMail })) };
});

vi.mock("nodemailer", () => ({ default: { createTransport } }));

beforeEach(() => {
  vi.stubEnv("MAIL_URL", "");
  vi.stubEnv("MAIL_FROM", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const message = {
  to: "person@example.com",
  subject: "Sign in",
  html: '<a href="https://example.com/sign-in">Sign in</a>',
  text: "https://example.com/sign-in",
};

describe("mail configuration", () => {
  it("defaults to the log driver locally", () => {
    expect(parseMailConfig({})).toEqual({
      driver: "log",
      from: "Atlas <no-reply@localhost>",
    });
  });

  it("rejects missing sender or malformed transport without disclosing secrets", () => {
    expect(() => parseMailConfig({ MAIL_URL: "smtp://user:secret@host:587" })).toThrow("MAIL_FROM");
    expect(() => parseMailConfig({ MAIL_URL: "resend://secret/key", MAIL_FROM: "a@b.co" })).toThrow(
      "Resend API key",
    );
    expect(() => parseMailConfig({ MAIL_URL: "http://secret", MAIL_FROM: "a@b.co" })).toThrow(
      "MAIL_URL must use",
    );
  });
});

describe("sendMail", () => {
  it("logs the whole magic link in local mode", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await sendMail(message);
    expect(info).toHaveBeenCalledWith("[mail]", {
      from: "Atlas <no-reply@localhost>",
      ...message,
    });
  });

  it("passes SMTP URL and message to nodemailer", async () => {
    vi.stubEnv("MAIL_URL", "smtps://person%40example.com:secret@smtp.example.com:465");
    vi.stubEnv("MAIL_FROM", "Atlas <person@example.com>");
    await sendMail(message);
    expect(createTransport).toHaveBeenCalledWith(process.env.MAIL_URL);
    expect(sendSmtpMail).toHaveBeenCalledWith({ from: process.env.MAIL_FROM, ...message });
  });

  it("posts to Resend and handles rejection without leaking the key", async () => {
    vi.stubEnv("MAIL_URL", "resend://re_secret");
    vi.stubEnv("MAIL_FROM", "Atlas <atlas@example.com>");
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 422 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMail(message)).rejects.toThrow("Resend rejected email (422)");
    expect(fetchMock).toHaveBeenCalledWith("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer re_secret", "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Atlas <atlas@example.com>", ...message }),
    });
  });

  it("rejects empty mail before contacting a provider", async () => {
    await expect(sendMail({ ...message, subject: " " })).rejects.toThrow("subject");
    expect(createTransport).not.toHaveBeenCalled();
  });
});
