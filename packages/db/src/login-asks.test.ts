/** "Já pedi login neste site" vale por conversa (30 min), não só por run; e é escopado ao dono. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { serializeConversationCard } from "@workspace/shared";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { listRecentLoginAsks } from "./login-asks.js";

const NOW = new Date("2026-10-27T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const loginCard = (site: string, extra: Record<string, unknown> = {}) =>
	serializeConversationCard({ v: 1, kind: "login", loginId: `l-${site}`, site, url: `https://${site}/login`, status: "pending", ...extra } as never);

let installed: { restore: () => void };

beforeEach(() => {
	installed = installFakes({
		conversation: new FakeTable([
			{ id: "conv-a", userId: "user-a" },
			{ id: "conv-b", userId: "user-b" },
		]),
		conversationMessage: new FakeTable([
			{ id: "m1", conversationId: "conv-a", role: "login", createdAt: minutesAgo(10), content: loginCard("painel.exemplo.com") },
			{ id: "m2", conversationId: "conv-a", role: "login", createdAt: minutesAgo(45), content: loginCard("velho.example.com") },
			{ id: "m3", conversationId: "conv-a", role: "login", createdAt: minutesAgo(5), content: loginCard("captcha.example.com", { reason: "captcha" }) },
			{ id: "m4", conversationId: "conv-b", role: "login", createdAt: minutesAgo(1), content: loginCard("outro.example.com") },
			{ id: "m5", conversationId: "conv-a", role: "assistant", createdAt: minutesAgo(2), content: "oi" },
		]),
	});
});
afterEach(() => installed.restore());

test("asked: só sites com card pendente nos últimos 30 min (sem captcha, sem outras mensagens)", async () => {
	assert.deepEqual((await listRecentLoginAsks("user-a", "conv-a", NOW)).asked, ["painel.exemplo.com"]);
});

test("login concluído (card done) deixa de suprimir: se a sessão cair de novo o card volta", async () => {
	installed.restore();
	installed = installFakes({
		conversation: new FakeTable([{ id: "conv-a", userId: "user-a" }]),
		conversationMessage: new FakeTable([
			{ id: "m1", conversationId: "conv-a", role: "login", createdAt: minutesAgo(10), content: loginCard("feito.example.com", { status: "done" }) },
			{ id: "m2", conversationId: "conv-a", role: "login", createdAt: minutesAgo(5), content: loginCard("aberto.example.com") },
		]),
	});
	assert.deepEqual((await listRecentLoginAsks("user-a", "conv-a", NOW)).asked, ["aberto.example.com"]);
});

test("vaultTried: sites onde o Cofre falhou nos últimos 30 min, mesmo com o card já concluído", async () => {
	installed.restore();
	installed = installFakes({
		conversation: new FakeTable([{ id: "conv-a", userId: "user-a" }]),
		conversationMessage: new FakeTable([
			{ id: "m1", conversationId: "conv-a", role: "login", createdAt: minutesAgo(10), content: loginCard("senha-errada.example.com", { status: "done", vaultTried: "O site pediu mais um passo" }) },
			{ id: "m2", conversationId: "conv-a", role: "login", createdAt: minutesAgo(50), content: loginCard("antigo.example.com", { vaultTried: "x" }) },
			{ id: "m3", conversationId: "conv-a", role: "login", createdAt: minutesAgo(5), content: loginCard("sem-cofre.example.com") },
		]),
	});
	const asks = await listRecentLoginAsks("user-a", "conv-a", NOW);
	assert.deepEqual(asks.vaultTried, ["senha-errada.example.com"]);
	assert.deepEqual(asks.asked, ["sem-cofre.example.com"]);
});

test("usuário B não enxerga os cards da conversa do usuário A", async () => {
	const empty = { asked: [], vaultTried: [] };
	assert.deepEqual(await listRecentLoginAsks("user-b", "conv-a", NOW), empty);
	assert.deepEqual(await listRecentLoginAsks("user-a", "conv-b", NOW), empty);
	assert.deepEqual(await listRecentLoginAsks("default", "conv-a", NOW), empty);
});
