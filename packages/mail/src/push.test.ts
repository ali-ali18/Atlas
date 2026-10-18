import { describe, expect, it, vi } from "vitest";
import { PUSH_TTL_SECONDS, createWebPushSender } from "./push.js";

const config = { publicKey: "pub", privateKey: "priv", subject: "mailto:a@b.c" };
const target = { endpoint: "https://push.example/1", p256dh: "pk", auth: "au" };

describe("createWebPushSender", () => {
  it("envia com VAPID, TTL e urgência alta", async () => {
    const sendNotification = vi.fn().mockResolvedValue({});
    const result = await createWebPushSender(config, { sendNotification }).send(target, "{}");
    expect(result).toEqual({ ok: true });
    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint: target.endpoint, keys: { p256dh: "pk", auth: "au" } },
      "{}",
      { vapidDetails: { subject: config.subject, publicKey: "pub", privateKey: "priv" }, TTL: PUSH_TTL_SECONDS, urgency: "high" },
    );
  });

  it("devolve o status HTTP da falha (410 = inscrição morta) sem lançar", async () => {
    const sendNotification = vi.fn().mockRejectedValue(Object.assign(new Error("Gone"), { statusCode: 410 }));
    expect(await createWebPushSender(config, { sendNotification }).send(target, "{}")).toEqual({ ok: false, status: 410, error: "Gone" });
  });

  it("erro de rede vem sem status", async () => {
    const sendNotification = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    expect(await createWebPushSender(config, { sendNotification }).send(target, "{}")).toEqual({ ok: false, status: undefined, error: "ECONNRESET" });
  });
});
