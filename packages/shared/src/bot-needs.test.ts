import { expect, test } from "vitest";
import { botNeedsUserStatusLine, needFromCardRow, parseBotNeedsUserCard, serializeBotLinkCard } from "./index.js";

const login = (status: string, extra: Record<string, unknown> = {}) =>
	JSON.stringify({ v: 1, kind: "login", loginId: "l1", site: "login.microsoftonline.com", url: "https://x", status, ...extra });

test("needFromCardRow: login pendente vira pedido com o run do destino; captcha e conector têm rótulo próprio", () => {
	const base = { rowId: "r1", conversationId: "cv", role: "login", targetRunId: "run-1" };
	expectEqual(needFromCardRow({ ...base, content: login("pending") }), {
		cardId: "r1",
		conversationId: "cv",
		type: "login",
		label: "Fazer login em login.microsoftonline.com",
		site: "login.microsoftonline.com",
		runId: "run-1",
	});
	expectStrict(needFromCardRow({ ...base, content: login("done") }), null);
	expectMatch(needFromCardRow({ ...base, content: login("pending", { reason: "captcha" }) })!.label, /captcha/);
	expectStrict(needFromCardRow({ ...base, content: login("pending", { runId: "run-9" }) })!.runId, "run-9");
});

test("needFromCardRow: confirm, perfil e questionário pendentes; resolvidos e outros cards não", () => {
	const row = (role: string, card: Record<string, unknown>) => ({ rowId: "r", conversationId: "cv", role, content: JSON.stringify({ v: 1, ...card }) });
	const confirm = needFromCardRow(row("confirm", { kind: "confirm", confirmId: "c", title: "Enviar e-mail", status: "pending", confirmLabel: "Enviar" }));
	expectEqual({ type: confirm?.type, label: confirm?.label, title: confirm?.confirmTitle, confirmLabel: confirm?.confirmLabel }, { type: "confirm", label: "Aprovar: Enviar e-mail", title: "Enviar e-mail", confirmLabel: "Enviar" });
	expectStrict(needFromCardRow(row("confirm", { kind: "confirm", confirmId: "c", title: "x", status: "approved" })), null);
	expectStrict(needFromCardRow(row("file", { kind: "file", artifactId: "a", filename: "f", mime: "x", size: 1, format: "text", version: 1 })), null);
});

test("marcador needs-user: ida e volta, descarta lixo, e a linha de status", () => {
	const card = { v: 1 as const, kind: "needs-user" as const, botMessageId: "m", botId: "b", botName: "Bobinho", title: "t", status: "pending" as const, need: { type: "login" as const, label: "Fazer login em x", cardId: "c", conversationId: "cv", runId: "r" } };
	expectEqual(parseBotNeedsUserCard(serializeBotLinkCard(card)), card);
	expectStrict(parseBotNeedsUserCard(JSON.stringify({ ...card, need: { ...card.need, type: "nope" } })), null);
	expectStrict(parseBotNeedsUserCard("{"), null);
	expectStrict(botNeedsUserStatusLine("Bobinho"), "Aguardando Bobinho — precisa de você");
});

function expectEqual(actual: unknown, expected: unknown): void {
	expect(actual).toEqual(expected);
}
function expectStrict(actual: unknown, expected: unknown): void {
	expect(actual).toBe(expected);
}
function expectMatch(actual: string, pattern: RegExp): void {
	expect(actual).toMatch(pattern);
}
