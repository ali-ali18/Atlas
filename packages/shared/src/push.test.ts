import { describe, expect, it } from "vitest";
import {
	COALESCE_WINDOW_MS,
	buildPushPayload,
	decideCoalesce,
	describeDevice,
	firstLine,
	isGonePushStatus,
	isProtocolText,
	parsePushSubscription,
	readVapidConfig,
} from "./push.js";

describe("texto da notificação", () => {
	it("terminou: só o nome do bot no título, primeira linha da resposta no corpo", () => {
		const payload = buildPushPayload({ kind: "run-finished", conversationId: "c1", botId: "b1", botName: "Adolfinho", text: "\n\n**Pronto**, publiquei o PR.\nDetalhes abaixo" });
		expect(payload).toMatchObject({ title: "Adolfinho", body: "Pronto, publiquei o PR.", tag: "c1", url: "/?bot=b1" });
		expect(payload?.icon).toBe("/icons/icon-192.png");
		expect(buildPushPayload({ kind: "run-finished", conversationId: "c1", botId: "b1", botName: "A", text: "x", iconUrl: "https://app/v1/avatars/blob-ff6700-v1.png" })?.icon).toBe("https://app/v1/avatars/blob-ff6700-v1.png");
		expect(payload?.badge).toBe("/icons/badge-72.png");
	});

	it("precisa de você: leva o cartão na URL", () => {
		const payload = buildPushPayload({ kind: "needs-user", conversationId: "c1", botId: "b1", botName: "Adolfinho", text: "Executar · pnpm test", cardId: "card 9" });
		expect(payload).toMatchObject({ title: "Adolfinho precisa de você", body: "Executar · pnpm test", url: "/?bot=b1&card=card+9", cardId: "card 9" });
	});

	it("sessão de código falhou e texto longo cortado", () => {
		const payload = buildPushPayload({ kind: "coding-failed", conversationId: "c1", botId: "b1", botName: "Dev", text: "x".repeat(400) });
		expect(payload?.title).toBe("Dev: a sessão de código falhou");
		expect(payload?.body.length).toBeLessThanOrEqual(140);
		expect(payload?.body.endsWith("…")).toBe(true);
	});

	it("alerta: título com ⚠️ e o nome do bot, resumo no corpo, abre a conversa", () => {
		const payload = buildPushPayload({ kind: "alert", conversationId: "c1", botId: "b1", botName: "Adolfinho", text: "⚠️ Estoque da canela: 7 un. (mínimo 10)" });
		expect(payload).toMatchObject({ title: "⚠️ Adolfinho", body: "Estoque da canela: 7 un. (mínimo 10)", url: "/?bot=b1", kind: "alert" });
		expect(buildPushPayload({ kind: "alert", conversationId: "c1", botName: "A" })?.body).toMatch(/alerta/i);
	});

	it("rotina que falhou: texto amigável no corpo e nunca engolido como protocolo", () => {
		const payload = buildPushPayload({ kind: "routine-failed", conversationId: "c1", botId: "b1", botName: "Adolfinho", text: "Sem créditos no provedor do modelo — a rotina Vendas não rodou" });
		expect(payload).toMatchObject({ title: "⚠️ Adolfinho", body: "Sem créditos no provedor do modelo — a rotina Vendas não rodou", kind: "routine-failed" });
	});

	it("alerta e falha de rotina passam na frente de um 'terminou' recente, mas não de 'precisa de você'", () => {
		const last = { at: 1_000_000, kind: "run-finished" as const };
		expect(decideCoalesce({ last, kind: "alert", now: last.at + 1000 })).toBe(true);
		expect(decideCoalesce({ last, kind: "routine-failed", now: last.at + 1000 })).toBe(true);
		expect(decideCoalesce({ last: { at: last.at, kind: "needs-user" }, kind: "alert", now: last.at + 1000 })).toBe(false);
	});

	it("protocolo de cartão nunca notifica", () => {
		expect(isProtocolText("confirmado: Executar")).toBe(true);
		expect(isProtocolText("Recusado")).toBe(true);
		expect(isProtocolText("cancela isso")).toBe(true);
		expect(isProtocolText("Terminei o relatório")).toBe(false);
		expect(buildPushPayload({ kind: "run-finished", conversationId: "c1", text: "confirmado: x" })).toBeNull();
	});

	it("sem texto usa frases padrão e sem bot usa o nome genérico", () => {
		expect(buildPushPayload({ kind: "run-finished", conversationId: "c1" })?.title).toBe("Seu bot");
		expect(buildPushPayload({ kind: "test", conversationId: "c1" })?.title).toBe("Notificações ativadas");
		expect(firstLine("  \n  ")).toBe("");
	});
});

describe("coalescência", () => {
	const last = { at: 1_000_000, kind: "run-finished" as const };
	it("primeira passa; dentro da janela só passa a mais urgente", () => {
		expect(decideCoalesce({ last: null, kind: "run-finished", now: 5 })).toBe(true);
		expect(decideCoalesce({ last, kind: "run-finished", now: last.at + 1000 })).toBe(false);
		expect(decideCoalesce({ last, kind: "needs-user", now: last.at + 1000 })).toBe(true);
		expect(decideCoalesce({ last: { at: last.at, kind: "needs-user" }, kind: "run-finished", now: last.at + 1000 })).toBe(false);
	});
	it("passada a janela, qualquer uma passa", () => {
		expect(decideCoalesce({ last, kind: "run-finished", now: last.at + COALESCE_WINDOW_MS })).toBe(true);
	});
});

describe("inscrição", () => {
	const ok = { endpoint: "https://push.example/abc", keys: { p256dh: "pk", auth: "au" } };
	it("aceita só https com chaves", () => {
		expect(parsePushSubscription(ok, "UA")).toEqual({ endpoint: ok.endpoint, p256dh: "pk", auth: "au", userAgent: "UA" });
		expect(parsePushSubscription({ ...ok, endpoint: "http://x/y" })).toBeNull();
		expect(parsePushSubscription({ endpoint: ok.endpoint, keys: { p256dh: "pk" } })).toBeNull();
		expect(parsePushSubscription("x")).toBeNull();
	});
	it("nome do aparelho, 404/410 e VAPID", () => {
		expect(describeDevice("Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36")).toBe("Chrome · Android");
		expect(describeDevice(null)).toBe("Aparelho");
		expect(isGonePushStatus(410)).toBe(true);
		expect(isGonePushStatus(404)).toBe(true);
		expect(isGonePushStatus(500)).toBe(false);
		expect(readVapidConfig({ WEB_PUSH_PUBLIC_KEY: "a", WEB_PUSH_PRIVATE_KEY: "b", WEB_PUSH_SUBJECT: "mailto:x@y.z" })).toEqual({ publicKey: "a", privateKey: "b", subject: "mailto:x@y.z" });
		expect(readVapidConfig({ WEB_PUSH_PUBLIC_KEY: "a", WEB_PUSH_PRIVATE_KEY: "b", WEB_PUSH_SUBJECT: "x" })).toBeNull();
		expect(readVapidConfig({})).toBeNull();
	});
});

describe("vapidProblems", () => {
	it("lista o que falta", async () => {
		const { vapidProblems } = await import("./push.js");
		expect(vapidProblems({})).toEqual(["WEB_PUSH_PUBLIC_KEY ausente", "WEB_PUSH_PRIVATE_KEY ausente", "WEB_PUSH_SUBJECT ausente"]);
		expect(vapidProblems({ WEB_PUSH_PUBLIC_KEY: "a", WEB_PUSH_PRIVATE_KEY: "b", WEB_PUSH_SUBJECT: "x" })).toEqual(["WEB_PUSH_SUBJECT deve começar com mailto: ou https://"]);
		expect(vapidProblems({ WEB_PUSH_PUBLIC_KEY: "a", WEB_PUSH_PRIVATE_KEY: "b", WEB_PUSH_SUBJECT: "mailto:a@b.c" })).toEqual([]);
	});
});
