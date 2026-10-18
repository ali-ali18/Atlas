import { describe, expect, it } from "vitest";
import {
	REFLECTION_DEFAULT_TIME,
	REFLECTION_FAILURE_LABELS,
	describeReflectionError,
	toReflectionFailure,
	REFLECTION_RECHECK_PREFIX,
	buildReflectionContext,
	buildRecheckObjective,
	decideReflectionOutcome,
	findDuplicatePending,
	formatOpenPending,
	formatReflectionMessage,
	groupReflectionEvents,
	isOpenPending,
	isRecheckObjective,
	isRecheckToolAllowed,
	isReflectionScheduleDue,
	markPendingResolved,
	parseRecheckResult,
	pickPendingsToRecheck,
	readReflectionSettings,
	reflectionSlotAt,
	reflectionTimeZone,
	type PendingEntry,
	type ReflectionEvent,
	type ReflectionMemory,
} from "./reflection.js";
import { parseAccountConfig, validateAccountConfigPatch } from "./account-config.js";

const SP = "America/Sao_Paulo";
const settings = { enabled: true, time: "06:30" };

describe("horário e fuso", () => {
	it("lê a configuração com padrões seguros", () => {
		expect(readReflectionSettings(null)).toEqual({ enabled: false, time: REFLECTION_DEFAULT_TIME });
		expect(readReflectionSettings({ reflection: { enabled: true, time: "7:05" } })).toEqual({ enabled: true, time: "07:05" });
		expect(readReflectionSettings({ reflection: { enabled: "yes", time: "99:99" } })).toEqual({ enabled: false, time: REFLECTION_DEFAULT_TIME });
		expect(reflectionTimeZone("Nope/Zone")).toBe(SP);
		expect(reflectionTimeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
	});

	it("o horário vale no fuso da conta", () => {
		// 06:30 em São Paulo = 09:30Z; em Tóquio = 21:30Z do dia anterior.
		const now = new Date("2026-10-15T12:00:00Z");
		expect(reflectionSlotAt(now, SP, "06:30").toISOString()).toBe("2026-10-15T09:30:00.000Z");
		expect(reflectionSlotAt(now, "Asia/Tokyo", "06:30").toISOString()).toBe("2026-10-14T21:30:00.000Z");
	});

	it("roda uma vez por dia, só depois do horário e só ligada", () => {
		const base = { settings, timeZone: SP };
		const before = new Date("2026-10-15T09:00:00Z"); // 06:00 em SP
		const after = new Date("2026-10-15T09:31:00Z"); // 06:31 em SP
		expect(isReflectionScheduleDue({ ...base, now: before, lastAttemptAt: null })).toBe(false);
		expect(isReflectionScheduleDue({ ...base, now: after, lastAttemptAt: null })).toBe(true);
		expect(isReflectionScheduleDue({ ...base, now: after, lastAttemptAt: new Date("2026-10-14T09:31:00Z") })).toBe(true);
		expect(isReflectionScheduleDue({ ...base, now: after, lastAttemptAt: new Date("2026-10-15T09:31:00Z") })).toBe(false);
		expect(isReflectionScheduleDue({ ...base, settings: { ...settings, enabled: false }, now: after, lastAttemptAt: null })).toBe(false);
		// Mudou para mais cedo (06:00): a tentativa de hoje (06:10) já conta.
		expect(isReflectionScheduleDue({ ...base, settings: { enabled: true, time: "06:00" }, now: after, lastAttemptAt: new Date("2026-10-15T09:10:00Z") })).toBe(false);
	});

	it("a conta aceita só enabled boolean e HH:MM", () => {
		expect(validateAccountConfigPatch({ reflection: { enabled: true, time: "06:30" } }).ok).toBe(true);
		expect(validateAccountConfigPatch({ reflection: { time: "6:30" } }).ok).toBe(false);
		expect(validateAccountConfigPatch({ reflection: { enabled: "sim" } }).ok).toBe(false);
		expect(parseAccountConfig({ v: 1, reflection: { enabled: true, time: "25:00" } }).reflection).toEqual({ enabled: true });
	});
});

const at = (iso: string) => new Date(iso);
const event = (over: Partial<ReflectionEvent>): ReflectionEvent => ({ botId: "b1", botName: "Ops", kind: "webhook", label: "webhook.received", detail: "dokploy-restart: servidor reiniciado", at: at("2026-10-15T11:43:00Z"), ...over });

describe("eventos (webhook, rotinas, erros)", () => {
	it("junta o mesmo webhook repetido em um grupo com contagem e período", () => {
		const { groups } = groupReflectionEvents([
			event({ detail: "dokploy-restart: servidor reiniciado #1234", at: at("2026-10-15T11:43:00Z") }),
			event({ detail: "dokploy-restart: servidor reiniciado #1235", at: at("2026-10-15T12:43:00Z") }),
			event({ detail: "dokploy-restart: servidor reiniciado #1236", at: at("2026-10-15T13:43:00Z") }),
			event({ label: "deploy.finished", detail: "app web ok" }),
		]);
		expect(groups).toHaveLength(2);
		const restart = groups.find((g) => g.label === "webhook.received")!;
		expect(restart.count).toBe(3);
		expect(restart.firstAt.toISOString()).toBe("2026-10-15T11:43:00.000Z");
		expect(restart.lastAt.toISOString()).toBe("2026-10-15T13:43:00.000Z");
	});

	it("rotina que deu certo é ruído (só contagem); a que falhou é fato", () => {
		const { groups, noise } = groupReflectionEvents([
			event({ kind: "routine", label: "Resumo da agenda", detail: "ok", ok: true }),
			event({ kind: "routine", label: "Resumo da agenda", detail: "ok", ok: true, at: at("2026-10-14T11:00:00Z") }),
			event({ kind: "routine", label: "Sync Bling", detail: "invalid_token", ok: false }),
			event({ kind: "reminder", label: "beber água", ok: true }),
		]);
		expect(noise).toBe(3);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.label).toBe("Sync Bling");
	});
});

const memory = (id: string, content: string, over: Partial<ReflectionMemory> = {}): ReflectionMemory => ({
	id,
	target: "memory",
	content,
	category: null,
	importance: null,
	validUntil: null,
	source: null,
	createdAt: at("2026-09-01T00:00:00Z"),
	updatedAt: at("2026-09-01T00:00:00Z"),
	...over,
});

describe("contexto da reflexão", () => {
	const input = {
		now: at("2026-10-15T09:30:00Z"),
		timeZone: SP,
		since: at("2026-10-14T09:30:00Z"),
		userMemories: [memory("u1", "Prefere respostas curtas", { target: "user" })],
		bots: [
			{ id: "orq", name: "Atlas Chefe", snippet: "Orquestrador", description: null, isOrchestrator: true, memories: [memory("o1", "[ABERTA] Sync Bling no n8n parado (origem: Grok Bot, 02/09)", { category: "pendencia" }), memory("o2", "Usa Dokploy")], summary: null, recent: [], newMessages: 0, events: [] },
			{
				id: "grok",
				name: "Grok Bot",
				snippet: "n8n",
				description: null,
				isOrchestrator: false,
				memories: [memory("g1", "n8n roda em srv1")],
				summary: "Usuário pediu ajuda com sync do Bling no n8n.",
				recent: [{ role: "user" as const, text: "o sync caiu de novo", at: at("2026-10-15T08:00:00Z") }],
				newMessages: 4,
				events: [event({ botId: "grok", botName: "Grok Bot" }), event({ botId: "grok", botName: "Grok Bot", at: at("2026-10-15T12:43:00Z") }), event({ botId: "grok", botName: "Grok Bot", kind: "routine", label: "x", ok: true })],
			},
		],
	};

	it("usa referências curtas, separa pendências abertas e agrupa eventos", () => {
		const { text, refs } = buildReflectionContext(input);
		expect(text).toContain("Pendências em aberto que você já acompanha");
		expect(text).toContain("Sync Bling no n8n parado");
		expect(text).toMatch(/Webhook: webhook\.received.*2x/);
		expect(text).toContain("1 execuções de rotina/lembrete sem problema");
		expect(text).toContain("Resumo da conversa (qualquer época)");
		const ref = [...refs.entries()].find(([, v]) => v.kind === "memory" && v.id === "g1")!;
		expect(ref[1]).toMatchObject({ kind: "memory", botId: "grok", target: "memory" });
		expect([...refs.values()].find((v) => v.kind === "memory" && v.id === "u1")).toMatchObject({ botId: null, target: "user" });
	});

	it("mostra as respostas marcadas com 👎 como nota (só leitura, no bot certo)", () => {
		const withDislike = { ...input, bots: input.bots.map((bot) => (bot.id === "grok" ? { ...bot, dislikedReplies: [{ text: "Não sei responder isso.", at: at("2026-10-15T09:00:00Z") }] } : bot)) };
		const { text } = buildReflectionContext(withDislike);
		expect(text).toContain("O usuário marcou 👎 numa resposta");
		expect(text).toContain("Não sei responder isso.");
		expect(buildReflectionContext(input).text).not.toContain("👎");
	});

	it("respeita o orçamento de texto", () => {
		const big = { ...input, bots: [{ ...input.bots[1]!, memories: Array.from({ length: 200 }, (_, i) => memory(`m${i}`, "x".repeat(400))) }] };
		expect(buildReflectionContext(big).text.length).toBeLessThanOrEqual(28_000);
	});
});

describe("pendências", () => {
	const entry = (id: string, content: string, importance: number, updated: string, category = "pendencia"): PendingEntry => ({ id, content, category, importance, createdAt: at("2026-09-01T00:00:00Z"), updatedAt: at(updated) });

	it("detecta aberta, formata e marca resolvida", () => {
		const text = formatOpenPending("Pediu ajuda com o sync do Bling no n8n; não confirmado resolvido", "Grok Bot", at("2026-10-15T12:00:00Z"), SP);
		expect(text).toMatch(/^\[ABERTA\] Pediu ajuda.*\(origem: Grok Bot, 15\/10\)$/);
		expect(isOpenPending({ content: text, category: "pendencia" })).toBe(true);
		const done = markPendingResolved(text, at("2026-10-16T12:00:00Z"), SP, "workflow voltou a rodar");
		expect(done).toMatch(/^\[RESOLVIDA 16\/10\]/);
		expect(isOpenPending({ content: done, category: "pendencia-resolvida" })).toBe(false);
		expect(isOpenPending({ content: done, category: "pendencia" })).toBe(false);
	});

	it("não duplica pendência já aberta", () => {
		const open = [{ content: "[ABERTA] sync do Bling no n8n parado (origem: Grok Bot, 02/09)", category: "pendencia" }];
		expect(findDuplicatePending(open, "Sync do Bling no n8n está parado")).toBe(open[0]);
		expect(findDuplicatePending(open, "Renovar domínio do site")).toBeUndefined();
	});

	it("escolhe no máximo 3, por importância e depois pela mais antiga; resolvidas nunca", () => {
		const list = [
			entry("a", "[ABERTA] a", 0.5, "2026-10-01T00:00:00Z"),
			entry("b", "[ABERTA] b", 0.9, "2026-10-10T00:00:00Z"),
			entry("c", "[ABERTA] c", 0.9, "2026-10-02T00:00:00Z"),
			entry("d", "[ABERTA] d", 0.7, "2026-10-03T00:00:00Z"),
			entry("e", "[RESOLVIDA 01/10] e", 0.99, "2026-09-01T00:00:00Z", "pendencia-resolvida"),
		];
		expect(pickPendingsToRecheck(list).map((p) => p.id)).toEqual(["c", "b", "d"]);
		expect(pickPendingsToRecheck(list, 0)).toEqual([]);
	});
});

describe("verificação somente leitura", () => {
	it("só passa leitura nativa ou conector declarado somente leitura", () => {
		expect(isRecheckToolAllowed("web_extract", undefined)).toBe(true);
		expect(isRecheckToolAllowed("mcp_tool_search", undefined)).toBe(true);
		expect(isRecheckToolAllowed("n8n_get_workflow", true)).toBe(true);
		// Escrita explícita, ou sem declaração (sem garantia): fora.
		expect(isRecheckToolAllowed("n8n_activate_workflow", false)).toBe(false);
		expect(isRecheckToolAllowed("n8n_unknown_tool", undefined)).toBe(false);
		for (const name of ["bash", "write_file", "memory", "notify_user", "schedule_followup", "send_to_bot", "propose_profile_update", "delegate_task", "create_file"]) {
			expect(isRecheckToolAllowed(name, undefined)).toBe(false);
		}
	});

	it("reconhece o run de verificação só em origem proactive com o marcador", () => {
		const objective = buildRecheckObjective([{ ref: "P1", text: "[ABERTA] sync" }], SP, at("2026-10-15T09:30:00Z"));
		expect(objective.startsWith(REFLECTION_RECHECK_PREFIX)).toBe(true);
		expect(objective).toContain("SOMENTE ferramentas que consultam");
		expect(isRecheckObjective("proactive", objective)).toBe(true);
		expect(isRecheckObjective("chat", objective)).toBe(false);
		expect(isRecheckObjective("proactive", "Reflexão diária")).toBe(false);
	});

	it("lê o JSON final, ignorando refs e status inválidos", () => {
		const text = 'Verifiquei.\n{"results":[{"ref":"P1","status":"problem","finding":"workflow falhando com invalid_token"},{"ref":"P2","status":"resolved","finding":"ok"},{"ref":"P9","status":"resolved"},{"ref":"P3","status":"talvez"}]}';
		expect(parseRecheckResult(text, ["P1", "P2", "P3"])).toEqual([
			{ ref: "P1", status: "problem", finding: "workflow falhando com invalid_token" },
			{ ref: "P2", status: "resolved", finding: "ok" },
		]);
		expect(parseRecheckResult("sem json", ["P1"])).toEqual([]);
		expect(parseRecheckResult(null, ["P1"])).toEqual([]);
	});
});

describe("resultado", () => {
	const change = { op: "remove", botId: "b", target: "memory", id: "1", before: "x", reason: "venceu" } as const;

	it("sem resumo não há mensagem nem push; sem nada a mostrar também não", () => {
		expect(decideReflectionOutcome({ summary: "", important: true, changes: [change] })).toEqual({ post: false, notify: false });
		expect(decideReflectionOutcome({ summary: "Tudo em ordem.", important: false, changes: [] })).toEqual({ post: false, notify: false });
	});

	it("limpeza sem urgência posta mas não notifica; importante notifica", () => {
		expect(decideReflectionOutcome({ summary: "Limpei duplicadas.", important: false, changes: [change] })).toEqual({ post: true, notify: false });
		expect(decideReflectionOutcome({ summary: "Sync do n8n falhando.", important: true, changes: [] })).toEqual({ post: true, notify: true });
		expect(decideReflectionOutcome({ summary: "Achei algo.", important: false, changes: [], problems: 1 })).toEqual({ post: true, notify: true });
	});

	it("a mensagem lista só pendências resolvidas/com problema e a contagem da limpeza", () => {
		const text = formatReflectionMessage("Resumo.", [change, { op: "pending-save", botId: "o", id: "p", content: "c", origin: "Grok Bot" }], [
			{ status: "problem", text: "[ABERTA] Sync Bling parado (origem: Grok, 02/09)", finding: "invalid_token desde 8/10" },
			{ status: "resolved", text: "[ABERTA] Domínio vencido", finding: "renovado" },
			{ status: "unknown", text: "[ABERTA] Backup", finding: "" },
		]);
		expect(text).toContain("Ainda com problema: Sync Bling parado");
		expect(text).toContain("Resolvida: Domínio vencido");
		expect(text).not.toContain("Backup");
		expect(text).toContain("Limpeza: 1 removida, 1 item salvo na minha memória.");
	});
});

describe("falhas da reflexão", () => {
	const http = (status: number, message: string) => Object.assign(new Error(message), { name: "OpenRouterError", status });
	const code = (error: unknown, stage: Parameters<typeof toReflectionFailure>[1] = "model") => toReflectionFailure(error, stage).code;

	it("classifica erros do OpenRouter por status e mensagem", () => {
		expect(code(http(401, "no auth"))).toBe("model_auth");
		expect(code(http(402, "credits"))).toBe("model_credits");
		expect(code(http(404, "No endpoints found for x"))).toBe("model_unavailable");
		expect(code(http(404, "No endpoints found that support tool use"))).toBe("model_no_tools");
		expect(code(http(429, "slow down"))).toBe("model_rate_limited");
		expect(code(http(503, "down"))).toBe("model_down");
		expect(code(http(400, "bad"))).toBe("model_error");
	});

	it("timeouts, banco e idempotência", () => {
		expect(code(new DOMException("First event or idle timeout", "TimeoutError"))).toBe("model_timeout");
		expect(code(Object.assign(new Error("boom"), { name: "PrismaClientKnownRequestError", code: "P2010" }), "context")).toBe("db_error");
		expect(code(new Error("x"), "post")).toBe("post_failed");
		const failure = toReflectionFailure(new Error("x"), "apply");
		expect(toReflectionFailure(failure, "model")).toBe(failure);
		expect(failure.label).toBe(REFLECTION_FAILURE_LABELS.unknown);
	});

	it("descreve o erro em uma linha e sem segredos", () => {
		const text = describeReflectionError(new Error("falhou\n com Bearer abcdefghijklmnop e sk-or-v1-123456789"), 200);
		expect(text).not.toMatch(/abcdefghijklmnop|sk-or-v1/);
		expect(text).not.toContain("\n");
	});
});
