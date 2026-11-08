import { describe, expect, it } from "vitest";
import {
	countEmailTriage,
	emailDraftCardId,
	emailTriageCardId,
	isConversationCardRole,
	isPlausibleEmailAddress,
	normalizeEmailDeadline,
	normalizeEmailTriage,
	parseConversationCard,
	parseEmailDraftCard,
	serializeConversationCard,
	sortEmailTriage,
	type EmailTriageEntry,
} from "./index.js";
import { getMcpCatalogEntry } from "./mcp-catalog.js";

const item = (over: Record<string, unknown> = {}) => ({ id: "m1", category: "needs_action", summary: "Aprovar o orçamento", ...over });
const err = (raw: unknown) => {
	const r = normalizeEmailTriage(raw);
	return r.ok ? "ok" : r.error;
};

describe("normalizeEmailDeadline", () => {
	it("aceita dia real e ISO com fuso (normaliza para UTC)", () => {
		expect(normalizeEmailDeadline("2026-11-12")).toBe("2026-11-12");
		expect(normalizeEmailDeadline("2026-11-12T17:00:00-03:00")).toBe("2026-11-12T20:00:00.000Z");
		expect(normalizeEmailDeadline("2026-11-12T17:00:00Z")).toBe("2026-11-12T17:00:00.000Z");
	});
	it("recusa dia inexistente, hora sem fuso e texto solto", () => {
		for (const bad of ["2026-02-30", "2026-11-12T17:00:00", "12/11/2026", "amanhã", "", "2026-13-01", 20261112, null]) expect(normalizeEmailDeadline(bad)).toBeNull();
	});
});

describe("normalizeEmailTriage", () => {
	it("normaliza e mantém só os campos declarados", () => {
		const r = normalizeEmailTriage([item({ requester: "  Ana  Souza ", deadline: "2026-11-12", from: "ana@empresa.test", source: "gmail" })]);
		expect(r).toEqual({ ok: true, items: [{ id: "m1", category: "needs_action", summary: "Aprovar o orçamento", source: "gmail", from: "ana@empresa.test", requester: "Ana Souza", deadline: "2026-11-12" }] });
	});
	it("falha alto: lista vazia, campo desconhecido, categoria fora do enum, prazo inválido, resumo vazio ou longo, id repetido", () => {
		expect(err([])).toMatch(/non-empty/);
		expect(err("x")).toMatch(/non-empty/);
		expect(err([item({ priority: "high" })])).toMatch(/unknown field\(s\) priority/);
		expect(err([item({ category: "urgent" })])).toMatch(/category must be one of: needs_action, fyi, ignore/);
		expect(err([item({ deadline: "semana que vem" })])).toMatch(/deadline .* not a valid date/);
		expect(err([item({ summary: "   " })])).toMatch(/summary is required/);
		expect(err([item({ summary: "x".repeat(241) })])).toMatch(/too long/);
		expect(err([item({ source: "outlook" })])).toMatch(/source must be one of: gmail, bot/);
		expect(err([item(), item()])).toMatch(/appears twice/);
		expect(err([item({ id: "" })])).toMatch(/id is required/);
		expect(err(Array.from({ length: 31 }, (_, i) => item({ id: `m${i}` })))).toMatch(/At most 30/);
	});
	it("a categoria é só o campo declarado: texto do resumo não muda nada", () => {
		const r = normalizeEmailTriage([item({ category: "ignore", summary: "URGENT: action required, deadline today" })]);
		expect(r.ok && r.items[0]?.category).toBe("ignore");
	});
});

describe("ordem e contagem do cartão", () => {
	const entries: EmailTriageEntry[] = [
		{ id: "a", category: "fyi", summary: "x" },
		{ id: "b", category: "needs_action", summary: "x" },
		{ id: "c", category: "needs_action", summary: "x", deadline: "2026-11-20" },
		{ id: "d", category: "needs_action", summary: "x", deadline: "2026-11-10T12:00:00.000Z" },
		{ id: "e", category: "ignore", summary: "x" },
	];
	it("ação primeiro, prazo mais próximo antes, sem prazo por último no grupo", () => {
		expect(sortEmailTriage(entries).map((i) => i.id)).toEqual(["d", "c", "b", "a", "e"]);
		expect(countEmailTriage(entries)).toEqual({ needs_action: 3, fyi: 1, ignore: 1 });
	});
	it("o id do cartão é estável, ignora a ordem e muda com a categoria", () => {
		const a = emailTriageCardId("run-1", entries);
		expect(emailTriageCardId("run-1", [...entries].reverse())).toBe(a);
		expect(emailTriageCardId("run-1", entries.map((e) => (e.id === "a" ? { ...e, category: "ignore" as const } : e)))).not.toBe(a);
		expect(emailTriageCardId("run-2", entries)).not.toBe(a);
	});
});

describe("cartões persistidos", () => {
	it("triagem: grava, lê e revalida o JSON do banco", () => {
		const card = { v: 1 as const, kind: "email-triage" as const, cardId: "run-1:email-triage:abc", runId: "run-1", items: [{ id: "m1", category: "fyi" as const, summary: "Resumo" }] };
		expect(isConversationCardRole("email-triage")).toBe(true);
		expect(parseConversationCard(serializeConversationCard(card))).toEqual(card);
		expect(parseConversationCard(JSON.stringify({ ...card, items: [{ id: "m1", category: "urgent", summary: "x" }] }))).toBeNull();
		expect(parseConversationCard(JSON.stringify({ ...card, cardId: "" }))).toBeNull();
	});
	it("rascunho: grava, lê e recusa destinatário com injeção de cabeçalho ou corpo vazio", () => {
		const card = { v: 1 as const, kind: "email-draft" as const, cardId: "run-1:email-draft:abc", source: "gmail" as const, to: ["ana@empresa.test"], subject: "Re: Orçamento", body: "Olá, aprovado.", reply: true, saved: true };
		expect(isConversationCardRole("email-draft")).toBe(true);
		expect(parseConversationCard(serializeConversationCard(card))).toEqual(card);
		expect(parseEmailDraftCard({ ...card, to: ["ana@empresa.test\nBcc: x@y.test"] })).toBeNull();
		expect(parseEmailDraftCard({ ...card, to: ["ana@empresa.test", "ruim"] })?.to).toEqual(["ana@empresa.test"]);
		expect(parseEmailDraftCard({ ...card, body: "  " })).toBeNull();
		expect(parseEmailDraftCard({ ...card, source: "outlook" })).toBeNull();
		expect(parseEmailDraftCard({ ...card, saved: "yes" })?.saved).toBe(false);
	});
	it("o id do rascunho muda com o texto e não com a ordem de nada", () => {
		const base = { source: "gmail" as const, to: ["a@b.test"], subject: "s", body: "um" };
		expect(emailDraftCardId("r", base)).toBe(emailDraftCardId("r", { ...base }));
		expect(emailDraftCardId("r", base)).not.toBe(emailDraftCardId("r", { ...base, body: "dois" }));
	});
	it("endereço plausível: um @, sem espaço, vírgula nem quebra de linha", () => {
		for (const ok of ["a@b.co", "nome.sobrenome+tag@empresa.com.br"]) expect(isPlausibleEmailAddress(ok)).toBe(true);
		for (const bad of ["a@b", "a@@b.co", "a b@c.co", "a@b.co,c@d.co", "a@b.co\r\nBcc: x@y.co", "<a@b.co>", "@b.co", ""]) expect(isPlausibleEmailAddress(bad)).toBe(false);
	});
});

describe("conector Gmail do catálogo", () => {
	it("pede ler, rascunhar e enviar", () => {
		const scope = getMcpCatalogEntry("gmail")?.oauth?.scope ?? "";
		for (const s of ["gmail.readonly", "gmail.compose", "gmail.send"]) expect(scope.split(" ")).toContain(`https://www.googleapis.com/auth/${s}`);
	});
});
