import webpush from "web-push";

/** Chaves VAPID e contato (e-mail ou URL) que o serviço de push exige. */
export type WebPushConfig = { publicKey: string; privateKey: string; subject: string };

export type WebPushTarget = { endpoint: string; p256dh: string; auth: string };

export type WebPushResult = { ok: true } | { ok: false; status?: number; error: string };

/** O mínimo do módulo `web-push` que usamos (trocável por um falso em teste). */
export type WebPushLib = {
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL: number; urgency: "very-low" | "low" | "normal" | "high"; topic?: string },
  ): Promise<unknown>;
};

/** Tempo que o serviço de push guarda a mensagem se o aparelho estiver sem rede (1h). */
export const PUSH_TTL_SECONDS = 3600;

/** Remetente Web Push. Nunca lança: devolve `ok:false` com o status HTTP (404/410 = inscrição morta). */
export function createWebPushSender(config: WebPushConfig, lib: WebPushLib = webpush as unknown as WebPushLib) {
  return {
    async send(target: WebPushTarget, payload: string): Promise<WebPushResult> {
      try {
        await lib.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, payload, {
          vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
          TTL: PUSH_TTL_SECONDS,
          urgency: "high",
        });
        return { ok: true };
      } catch (error) {
        const status = typeof (error as { statusCode?: unknown })?.statusCode === "number" ? (error as { statusCode: number }).statusCode : undefined;
        return { ok: false, status, error: error instanceof Error ? error.message : "falha no envio" };
      }
    },
  };
}

/** Gera um par de chaves VAPID (uso: script `pnpm push:vapid`). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}
