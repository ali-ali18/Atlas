import { describe, expect, it } from "vitest";
import {
	insertCardAfterCurrentTurn,
	isConversationCardRole,
	parseConversationCard,
	serializeConversationCard,
} from "./skill-card.js";

describe("conversation skill cards", () => {
	it("valida marcador JEV sem aceitar argumentos ou texto", () => {
		const card = {
			v: 1 as const,
			kind: "jev-status" as const,
			runId: "run-1",
			toolCallId: "call-1",
			mode: "gate" as const,
			result: "allow" as const,
			ok: true,
		};
		expect(isConversationCardRole(card.kind)).toBe(true);
		expect(parseConversationCard(serializeConversationCard(card))).toEqual(card);
		expect(parseConversationCard(JSON.stringify({ ...card, args: { token: "secret" } }))).toEqual(card);
		expect(parseConversationCard(JSON.stringify({ ...card, runId: "" }))).toBeNull();
		expect(parseConversationCard(JSON.stringify({ ...card, mode: "unknown" }))).toBeNull();
		expect(parseConversationCard(JSON.stringify({ ...card, ok: "true" }))).toBeNull();
	});
	it("round trips a listed card", () => {
		const card = {
			v: 1 as const,
			kind: "skill" as const,
			action: "listed" as const,
			items: [
				{
					capabilityKey: "read-page",
					title: "Ler página",
					versionNumber: 2,
					status: "active" as const,
				},
			],
			draftCount: 1,
		};
		expect(parseConversationCard(serializeConversationCard(card))).toEqual(card);
	});

	it("round trips a confirm card and defaults missing status to pending", () => {
		const raw = serializeConversationCard({
			v: 1,
			kind: "confirm",
			confirmId: "confirm-run-1",
			title: "Apagar a skill?",
			status: "pending",
		});
		expect(parseConversationCard(raw)).toMatchObject({
			kind: "confirm",
			confirmId: "confirm-run-1",
			status: "pending",
		});
		const withoutStatus = raw.replace(`"status":"pending"`, `"status":"nope"`);
		expect(parseConversationCard(withoutStatus)?.kind === "confirm" && parseConversationCard(withoutStatus)).toMatchObject({
			status: "pending",
		});
	});

	it("rejects creating payloads and garbage", () => {
		expect(parseConversationCard(`{"v":1,"kind":"skill","action":"creating"}`)).toBeNull();
		expect(parseConversationCard("not json")).toBeNull();
		expect(parseConversationCard(`{"v":2,"kind":"skill","action":"listed"}`)).toBeNull();
	});

	it("inserts the card after the triggering user, not after later turns", () => {
		const thread = [
			{ id: "1", kind: "user" },
			{ id: "2", kind: "assistant" },
			{ id: "3", kind: "user" },
		];
		const next = insertCardAfterCurrentTurn(thread, { id: "card", kind: "skill" });
		expect(next.map((item) => item.id)).toEqual(["1", "2", "3", "card"]);
	});

	it("keeps later assistant text after the cards of the current turn", () => {
		const thread = [
			{ id: "u1", kind: "user" },
			{ id: "a1", kind: "assistant" },
			{ id: "u2", kind: "user" },
			{ id: "a2", kind: "assistant" },
		];
		const next = insertCardAfterCurrentTurn(thread, { id: "list", kind: "skill" });
		expect(next.map((item) => item.id)).toEqual(["u1", "a1", "u2", "list", "a2"]);
	});

	it("mantém failed (aprovado que falhou ao executar) distinto de rejected, com o motivo", () => {
		const raw = serializeConversationCard({ v: 1, kind: "confirm", confirmId: "c9", title: "Criar proposta?", status: "failed", outcome: { ok: false, detail: "campo obrigatório ausente" } });
		expect(parseConversationCard(raw)).toMatchObject({ kind: "confirm", status: "failed", outcome: { ok: false, detail: "campo obrigatório ausente" } });
	});

	it("stacks confirm then deleted in the same turn", () => {
		const once = insertCardAfterCurrentTurn(
			[{ id: "u", kind: "user" }],
			{ id: "c", kind: "confirm" },
		);
		const twice = insertCardAfterCurrentTurn(once, { id: "d", kind: "skill" });
		expect(twice.map((item) => item.id)).toEqual(["u", "c", "d"]);
	});

	it("round trips a bot-profile card and rejects empty proposals", () => {
		const card = {
			v: 1 as const,
			kind: "bot-profile" as const,
			proposalId: "profile-run-1",
			botId: "bot-1",
			before: {
				name: "Tom",
				snippet: "Bot recém-criado",
				description: null,
				openRouterModel: null,
			},
			after: { description: "Assistente do dia a dia" },
			fields: ["description" as const],
			status: "pending" as const,
		};
		expect(parseConversationCard(serializeConversationCard(card))).toEqual(card);
		const empty = serializeConversationCard({ ...card, after: {}, fields: [] });
		expect(parseConversationCard(empty)).toBeNull();
	});

	it("inserts bot-profile cards after the current turn", () => {
		const thread = [
			{ id: "u1", kind: "user" },
			{ id: "a1", kind: "assistant" },
		];
		const next = insertCardAfterCurrentTurn(thread, {
			id: "p1",
			kind: "bot-profile",
		});
		expect(next.map((item) => item.id)).toEqual(["u1", "p1", "a1"]);
	});

	it("round trips a questionnaire card with purpose + originalRequest (fix: task answers never propose a profile update)", () => {
		const card = {
			v: 1 as const,
			kind: "questionnaire" as const,
			questionnaireId: "questionnaire-run-1",
			title: "Onde te aviso?",
			status: "pending" as const,
			items: [
				{
					name: "canal",
					prompt: "Onde te aviso do deploy?",
					choices: [{ value: "chat" }, { value: "email" }],
				},
			],
			purpose: "task" as const,
			originalRequest: "me lembra de dar deploy dia 03/10 pelo chat",
		};
		expect(parseConversationCard(serializeConversationCard(card))).toEqual(card);
	});

	it("questionnaire card legado (sem purpose/originalRequest) continua parseando normalmente", () => {
		const raw = serializeConversationCard({
			v: 1,
			kind: "questionnaire",
			questionnaireId: "questionnaire-legacy",
			title: "Qual seu foco?",
			status: "pending",
			items: [
				{
					name: "direction",
					prompt: "Qual é o foco do bot?",
					choices: [{ value: "suporte" }],
				},
			],
		});
		const parsed = parseConversationCard(raw);
		expect(parsed?.kind === "questionnaire" && parsed.purpose).toBeUndefined();
		expect(
			parsed?.kind === "questionnaire" && parsed.originalRequest,
		).toBeUndefined();
	});
});

describe("card tool-budget", () => {
	it("faz round trip e recusa teto que não cresceu", () => {
		const card = {
			v: 1 as const,
			kind: "tool-budget" as const,
			tool: "mcp__github__get_file_contents",
			connectorName: "GitHub",
			from: 40,
			to: 60,
		};
		expect(parseConversationCard(serializeConversationCard(card))).toEqual(card);
		expect(
			parseConversationCard(JSON.stringify({ ...card, to: 40 })),
		).toBeNull();
		expect(parseConversationCard(JSON.stringify({ ...card, tool: "" }))).toBeNull();
	});
});

describe("card subagents", () => {
	it("faz o parse, limita o tamanho e descarta card sem tarefas", () => {
		const card = parseConversationCard(
			JSON.stringify({
				v: 1,
				kind: "subagents",
				groupId: "run-1-d1",
				tasks: [
					{ taskIndex: 0, title: "Amazon", goal: "Buscar na Amazon", status: "ok", summary: "R$ 1", toolsUsed: ["web_search"], model: "openai/gpt-5" },
					{ taskIndex: 1, goal: "Kabum", status: "weird", summary: "x".repeat(5000), toolsUsed: [] },
					{ taskIndex: 2 },
				],
			}),
		);
		expect(card).toMatchObject({ kind: "subagents", groupId: "run-1-d1" });
		if (card?.kind !== "subagents") throw new Error("kind");
		expect(card.tasks).toHaveLength(2);
		expect(card.tasks[0]?.model).toBe("openai/gpt-5");
		expect(card.tasks[0]?.title).toBe("Amazon");
		expect(card.tasks[1]?.title).toBeUndefined();
		expect(card.tasks[1]?.model).toBeUndefined();
		expect(card.tasks[1]).toMatchObject({ status: "failed" });
		expect(card.tasks[1]?.summary.length).toBe(5000);
		expect(parseConversationCard(JSON.stringify({ v: 1, kind: "subagents", groupId: "g", tasks: [] }))).toBeNull();
		expect(isConversationCardRole("subagents")).toBe(true);
	});
});

describe("F9 - card de arquivo", () => {
	it("persiste e lê o card de arquivo (role file)", () => {
		expect(isConversationCardRole("file")).toBe(true);
		const card = {
			v: 1 as const,
			kind: "file" as const,
			artifactId: "art1",
			filename: "pvu.pdf",
			mime: "application/pdf",
			size: 2048,
			format: "pdf" as const,
			version: 2,
			runId: "run1",
		};
		expect(parseConversationCard(serializeConversationCard(card))).toEqual(card);
		expect(parseConversationCard(JSON.stringify({ ...card, artifactId: "" }))).toBeNull();
		expect(parseConversationCard(JSON.stringify({ ...card, size: -1 }))).toBeNull();
		expect(parseConversationCard(JSON.stringify({ ...card, format: "exe", version: 0 }))).toMatchObject({ format: "text", version: 1 });
	});

	it("fica junto dos outros cards do turno", () => {
		const out = insertCardAfterCurrentTurn(
			[{ kind: "user" }, { kind: "file" }, { kind: "assistant" }],
			{ kind: "file" },
		);
		expect(out.map((m) => m.kind)).toEqual(["user", "file", "file", "assistant"]);
	});
});

describe("F12/B5 - card de login", () => {
	it("persiste e lê o card de login (role login)", () => {
		expect(isConversationCardRole("login")).toBe(true);
		const card = {
			v: 1 as const,
			kind: "login" as const,
			loginId: "login-run1-abc",
			site: "bling.com.br",
			url: "https://www.bling.com.br/login",
			runId: "run1",
			status: "pending" as const,
		};
		expect(parseConversationCard(serializeConversationCard(card))).toEqual(card);
		expect(parseConversationCard(JSON.stringify({ ...card, status: "x" }))).toMatchObject({ status: "pending" });
		expect(parseConversationCard(JSON.stringify({ ...card, loginId: "" }))).toBeNull();
	});

	it("card de captcha guarda o motivo; valor desconhecido some", () => {
		const card = {
			v: 1 as const,
			kind: "login" as const,
			loginId: "captcha-run1-abc",
			site: "google.com",
			url: "https://www.google.com/sorry/index",
			status: "pending" as const,
			reason: "captcha" as const,
		};
		expect(parseConversationCard(serializeConversationCard(card))).toEqual(card);
		const odd = parseConversationCard(JSON.stringify({ ...card, reason: "x" }));
		expect(odd).not.toHaveProperty("reason");
	});

	it("fica junto dos outros cards do turno", () => {
		const out = insertCardAfterCurrentTurn(
			[{ kind: "user" }, { kind: "login" }, { kind: "assistant" }],
			{ kind: "confirm" },
		);
		expect(out.map((m) => m.kind)).toEqual(["user", "login", "confirm", "assistant"]);
	});
});

describe("card de confirmação de conector", () => {
	it("guarda callKey e o resultado executado, sem campos extras", () => {
		const card = { v: 1, kind: "confirm", confirmId: "c1", title: "Composio: executar \"X\"?", status: "rejected", callKey: "abc", outcome: { ok: false, detail: "erro" } } as const;
		expect(parseConversationCard(serializeConversationCard(card))).toEqual(card);
		const parsed = parseConversationCard(JSON.stringify({ ...card, outcome: { ok: "sim" }, token: "x" }));
		expect(parsed).toEqual({ v: 1, kind: "confirm", confirmId: "c1", title: card.title, status: "rejected", callKey: "abc" });
	});
});
