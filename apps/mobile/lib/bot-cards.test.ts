import type { BotProposalEvent, SessionMessage } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { applyDecidedProposals, type BotProfileItem, type BotProposalItem, botProfileTitle, botProposalFromEvent, botProposalTitle, homeBotFromProposal, profileRows, proposalKey, proposalModelLabel, skillLabel, summarizeTask, withProposalResolution } from "./bot-cards";
import { applyRunEvent, createLiveState } from "./chat-live";
import { dedupeKeys, reconcile, sessionMessageToItem } from "./chat-thread";
import type { ChatItem } from "./chat-types";

const card = (over: Partial<BotProposalItem> = {}): BotProposalItem => ({ id: "db1", kind: "bot-proposal", proposalId: "p1", status: "pending", name: "Estoquinho", description: "Cuida do estoque", color: "#1084FE", shape: "blob", model: null, skills: [], firstTask: null, ...over });
const profile = (over: Partial<BotProfileItem> = {}): BotProfileItem => ({ id: "db2", kind: "bot-profile", proposalId: "pf1", botId: "bot1", status: "pending", fields: ["name", "description"], before: { name: "Cookie", snippet: "", description: null, openRouterModel: null }, after: { name: "Biscoito", description: "Ajuda com a rotina" }, ...over });
const event: BotProposalEvent = { type: "bot-proposal", proposalId: "p1", name: "Estoquinho", description: "Cuida do estoque", snippet: "Estoque", color: "blue", shape: "blob", model: "anthropic/claude-sonnet", skills: ["daily-report"], firstTask: "Conferir o estoque de hoje" };
const row = (role: string, content: object): SessionMessage => ({ id: `db-${role}`, conversationId: "c1", role, content: JSON.stringify(content), createdAt: "2026-11-01T10:00:00.000Z" }) as SessionMessage;

describe("do gravado e do evento ao cartão", () => {
	it("o cartão gravado de proposta de agente vira o item nativo (e não mais uma linha para o navegador)", () => {
		const item = sessionMessageToItem(row("bot-proposal", { v: 1, kind: "bot-proposal", proposalId: "p1", status: "pending", name: "Estoquinho", description: "Cuida do estoque", color: "#1084FE", shape: "star", model: "x/y", skills: ["a-b"], firstTask: "Tarefa" }));
		expect(item).toMatchObject({ kind: "bot-proposal", id: "db-bot-proposal", proposalId: "p1", status: "pending", name: "Estoquinho", shape: "star", model: "x/y", skills: ["a-b"], firstTask: "Tarefa" });
	});
	it("o cartão gravado de perfil vira o item nativo", () => {
		const item = sessionMessageToItem(row("bot-profile", { v: 1, kind: "bot-profile", proposalId: "pf1", botId: "bot1", status: "pending", fields: ["name"], before: { name: "A", snippet: "", description: null, openRouterModel: null }, after: { name: "B" } }));
		expect(item).toMatchObject({ kind: "bot-profile", proposalId: "pf1", botId: "bot1", fields: ["name"], after: { name: "B" } });
	});
	it("cartão malformado não aparece", () => {
		expect(sessionMessageToItem(row("bot-proposal", { v: 1, kind: "bot-proposal", proposalId: "p1" }))).toBeNull();
	});
	it("o evento ao vivo vira o mesmo item, com id estável e a cor da paleta em hex", () => {
		expect(botProposalFromEvent(event)).toMatchObject({ id: "bot-proposal-p1", kind: "bot-proposal", status: "pending", color: "#1084FE", skills: ["daily-report"], model: "anthropic/claude-sonnet" });
		expect(botProposalFromEvent({ ...event, name: "" })).toBeNull();
	});
	it("o evento SSE entra uma vez só no estado ao vivo e o repetido pendente não desfaz o decidido", () => {
		let state = applyRunEvent(createLiveState(), event);
		state = applyRunEvent(state, event);
		expect(state.items.map((item) => item.kind)).toEqual(["bot-proposal"]);
		state = applyRunEvent(state, { ...event, status: "approved", botId: "bot-9" });
		expect(state.items[0]).toMatchObject({ status: "approved", botId: "bot-9", id: "bot-proposal-p1" });
		state = applyRunEvent(state, event);
		expect(state.items[0]).toMatchObject({ status: "approved" });
	});
	it("o evento ao vivo de perfil vira o cartão de perfil", () => {
		const state = applyRunEvent(createLiveState(), { type: "bot-profile", proposalId: "pf1", botId: "bot1", before: { name: "A", snippet: "", description: null, openRouterModel: null }, after: { name: "B" }, fields: ["name"] });
		expect(state.items[0]).toMatchObject({ kind: "bot-profile", proposalId: "pf1", status: "pending" });
	});
});

describe("ao vivo × gravado: um cartão só, o decidido vence", () => {
	it("o gravado pendente e o ao vivo da mesma proposta viram um (o gravado fica)", () => {
		const merged = reconcile([card()], [card({ id: "bot-proposal-p1" })]);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({ id: "db1", status: "pending" });
	});
	it("ao vivo decidido e gravado ainda pendente: fica o gravado, com o estado e o botId do decidido", () => {
		const merged = reconcile([card()], [card({ id: "bot-proposal-p1", status: "approved", botId: "bot-9" })]);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({ id: "db1", status: "approved", botId: "bot-9" });
	});
	it("gravado decidido e ao vivo pendente: vale o decidido", () => {
		const merged = reconcile([card({ status: "rejected" })], [card({ id: "bot-proposal-p1" })]);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({ status: "rejected" });
	});
	it("só o ao vivo (o servidor ainda não gravou) aparece na ordem do fio", () => {
		const merged = reconcile([{ id: "u1", kind: "user", text: "cria um agente" }], [card({ id: "bot-proposal-p1" })]);
		expect(merged.map((item) => item.kind)).toEqual(["user", "bot-proposal"]);
	});
	it("duas cópias gravadas viram uma, com o estado mais decidido; propostas diferentes não se misturam", () => {
		const merged = dedupeKeys(applyDecidedProposals([card(), card({ id: "db1b", status: "approved", botId: "bot-9" }), card({ id: "db3", proposalId: "p2" })]));
		expect(merged.map((item) => item.id)).toEqual(["db1", "db3"]);
		expect(merged[0]).toMatchObject({ status: "approved", botId: "bot-9" });
		expect(merged[1]).toMatchObject({ status: "pending" });
	});
	it("aprovado vale mais que recusado entre cópias", () => {
		const merged = applyDecidedProposals([card(), card({ id: "x", status: "rejected" }), card({ id: "y", status: "approved", botId: "b" })]);
		expect(merged[0]).toMatchObject({ status: "approved", botId: "b" });
	});
	it("a chave separa agente de perfil com o mesmo id", () => {
		expect(proposalKey(card({ proposalId: "z" }))).toBe("bot-proposal|z");
		expect(proposalKey(profile({ proposalId: "z" }))).toBe("bot-profile|z");
		expect(reconcile([card({ proposalId: "z" })], [profile({ proposalId: "z" })]).map((item) => item.kind)).toEqual(["bot-proposal", "bot-profile"]);
	});
	it("perfil decidido vence entre ao vivo e gravado", () => {
		const merged = reconcile([profile()], [profile({ id: "bot-profile-pf1", status: "approved" })]);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({ id: "db2", status: "approved" });
	});
});

describe("resolução local no cartão", () => {
	it("em voo trava, com erro mostra a frase e feito mostra o resultado; decidido não é tocado", () => {
		const key = proposalKey(card());
		expect(withProposalResolution(card(), { [key]: { phase: "applying" } })).toMatchObject({ applying: true, status: "pending" });
		expect(withProposalResolution(card(), { [key]: { phase: "error", text: "Esta proposta não existe mais." } })).toMatchObject({ error: "Esta proposta não existe mais." });
		expect(withProposalResolution(card(), { [key]: { phase: "done", status: "approved", botId: "b", name: "Novo nome" } })).toMatchObject({ status: "approved", botId: "b", name: "Novo nome" });
		expect(withProposalResolution(card({ status: "rejected" }), { [key]: { phase: "done", status: "approved", botId: "b" } })).toMatchObject({ status: "rejected" });
		const other: ChatItem = { id: "u", kind: "user", text: "oi" };
		expect(withProposalResolution(other, { [key]: { phase: "applying" } })).toBe(other);
	});
});

describe("textos para o usuário", () => {
	it("título e selo seguem o estado, sempre com a palavra do produto (Habilidades, nunca skill)", () => {
		expect(botProposalTitle(card())).toBe("Criar o agente “Estoquinho”?");
		expect(botProposalTitle(card({ status: "approved" }))).toBe("Agente criado: “Estoquinho”");
		expect(botProposalTitle(card({ status: "rejected" }))).toBe("Proposta dispensada: “Estoquinho”");
		expect(skillLabel("daily-report")).toBe("Daily report");
		expect(proposalModelLabel(null)).toBe("Modelo padrão");
		expect(proposalModelLabel("anthropic/claude-sonnet")).toBe("claude-sonnet");
	});
	it("a primeira tarefa vira uma linha curta", () => {
		expect(summarizeTask("  confere\n\n o estoque  ")).toBe("confere o estoque");
		expect(summarizeTask("a".repeat(300), 20)).toHaveLength(20);
		expect(summarizeTask("a".repeat(300), 20).endsWith("…")).toBe(true);
	});
	it("perfil: linhas de antes e depois e título", () => {
		expect(profileRows(profile())).toEqual([
			{ field: "name", label: "Nome", before: "Cookie", after: "Biscoito" },
			{ field: "description", label: "Briefing", before: "—", after: "Ajuda com a rotina" },
		]);
		expect(botProfileTitle(profile())).toBe("Atualizar perfil?");
		expect(botProfileTitle(profile({ fields: ["name"] }))).toBe("Atualizar nome?");
		expect(botProfileTitle(profile({ status: "approved" }))).toBe("Perfil atualizado");
	});
	it("o bot criado pelo cartão entra na home com a aparência da proposta e sem conversa gravada", () => {
		expect(homeBotFromProposal(card({ color: "#FF6700", shape: "hex" }), { botId: "b9", name: "Nome do servidor" }, new Date("2026-11-03T10:00:00Z"))).toMatchObject({ id: "b9", name: "Nome do servidor", color: "#FF6700", shape: "hex", isPrimary: false, pinned: false, conversationId: null, lastAt: "2026-11-03T10:00:00.000Z" });
	});
});
