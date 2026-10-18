import { describe, expect, it } from "vitest";
import {
	autoDecisionNote,
	buildAutoDecisionCard,
	buildBotPendingItem,
	decideBotPending,
	decideBotQuestionnaire,
	formatPendingItemsForModel,
	needFromCardRow,
	parseBotAutoDecisionCard,
	parseBotNeedsUserCard,
	readDecideForOtherBots,
	serializeBotLinkCard,
	splitPendingItemsBlock,
	withDecideForOtherBots,
	type BotPendingItem,
	type PendingJevVerdict,
} from "./index.js";

const confirmCard = (extra: Record<string, unknown> = {}) =>
	JSON.stringify({ v: 1, kind: "confirm", confirmId: "c1", title: "Executar este comando?", status: "pending", confirmLabel: "Executar", cancelLabel: "Pular", ...extra });

const commandItem = (command: string): BotPendingItem =>
	buildBotPendingItem({ rowId: "row1", role: "confirm", content: confirmCard({ devApproval: { kind: "command", command, cwd: "/workspace" } }) })!;

const jevYes: PendingJevVerdict = { withinScope: 0.95, reversible: 0.9, harmlessOutward: 0.95 };
const proposal = (decision: "approve" | "reject", confidence = 0.9) => ({ decision, reason: "dentro do pedido", confidence });
const base = { enabled: true, unattended: false };

describe("buildBotPendingItem", () => {
	it("comando: título, prévia, motivo, opções e handle", () => {
		const item = buildBotPendingItem({
			rowId: "row1",
			role: "confirm",
			content: confirmCard({ devApproval: { kind: "command", command: "pnpm test", cwd: "/workspace", reason: "não está na lista" } }),
		})!;
		expect(item).toMatchObject({ handle: "row1", kind: "command", title: "Executar este comando?", preview: "pnpm test", reason: "não está na lista", confirmId: "c1" });
		expect(item.options.map((o) => o.value)).toEqual(["approve", "reject"]);
		expect(item.options.map((o) => o.label)).toEqual(["Executar", "Pular"]);
		expect(item.hardDeny).toBeUndefined();
	});

	it("redige segredos da prévia como o card", () => {
		const secret = "abcdefghijklmnop12345";
		const item = buildBotPendingItem({
			rowId: "r",
			role: "confirm",
			content: confirmCard({ devApproval: { kind: "command", command: `curl -H "Authorization: Bearer ${secret}" https://x.dev`, cwd: "/w" } }),
		})!;
		expect(item.preview).not.toContain(secret);
		expect(item.preview).toContain("[redacted]");
		expect(JSON.stringify(item)).not.toContain(secret);
	});

	it("comando com bloqueio fixo carrega hardDeny", () => {
		const item = buildBotPendingItem({ rowId: "r", role: "confirm", content: confirmCard({ devApproval: { kind: "command", command: "git push --force origin main", cwd: "/w" } }) })!;
		expect(item.hardDeny).toBeTruthy();
	});

	it("escrita: caminho e diff na prévia", () => {
		const item = buildBotPendingItem({
			rowId: "r",
			role: "confirm",
			content: confirmCard({ devApproval: { kind: "write", path: "src/a.ts", preview: "+linha", added: 1, removed: 0 } }),
		})!;
		expect(item.kind).toBe("write");
		expect(item.preview).toContain("src/a.ts");
		expect(item.preview).toContain("+linha");
	});

	it("MCP: classe vem da intenção; sem ela vale como irreversível", () => {
		const content = confirmCard({ title: "Gmail: executar enviar?", description: "to: a@b.c" });
		expect(buildBotPendingItem({ rowId: "r", role: "confirm", content, intent: { action: "mcp-call", actionClass: "write" } })).toMatchObject({ kind: "mcp", preview: "to: a@b.c" });
		expect(buildBotPendingItem({ rowId: "r", role: "confirm", content, intent: { action: "mcp-call", actionClass: "write" } })!.irreversible).toBeUndefined();
		expect(buildBotPendingItem({ rowId: "r", role: "confirm", content, intent: { action: "mcp-call", actionClass: "irreversible" } })!.irreversible).toBe(true);
		expect(buildBotPendingItem({ rowId: "r", role: "confirm", content, intent: { action: "mcp-call" } })!.irreversible).toBe(true);
	});

	it("card já resolvido não é item pendente", () => {
		expect(buildBotPendingItem({ rowId: "r", role: "confirm", content: confirmCard({ status: "approved" }) })).toBeNull();
	});

	it("questionário pendente leva perguntas e escolhas", () => {
		const item = buildBotPendingItem({
			rowId: "q1",
			role: "questionnaire",
			content: JSON.stringify({ v: 1, kind: "questionnaire", questionnaireId: "qq", title: "Qual ambiente?", status: "pending", items: [{ name: "env", prompt: "Ambiente", required: true, choices: [{ value: "dev" }, { value: "prod" }] }] }),
		})!;
		expect(item.kind).toBe("questionnaire");
		expect(item.questionnaire?.items[0]?.choices?.map((c) => c.value)).toEqual(["dev", "prod"]);
	});

	it("needFromCardRow anexa o item e o marcador sobrevive à serialização", () => {
		const need = needFromCardRow({ rowId: "row1", conversationId: "conv", role: "confirm", content: confirmCard({ devApproval: { kind: "command", command: "pnpm test", cwd: "/w" } }) })!;
		expect(need.item?.preview).toBe("pnpm test");
		const marker = serializeBotLinkCard({ v: 1, kind: "needs-user", botMessageId: "m", botId: "b", botName: "Dev", title: "t", need, status: "pending" });
		expect(parseBotNeedsUserCard(marker)?.need.item?.preview).toBe("pnpm test");
	});
});

describe("formatPendingItemsForModel", () => {
	it("bloco estruturado volta intacto e some do texto", () => {
		const block = formatPendingItemsForModel([commandItem("pnpm test")]);
		const split = splitPendingItemsBlock(`Terminei a parte 1.\n${block}`);
		expect(split.text).toBe("Terminei a parte 1.");
		expect(split.items).toHaveLength(1);
		expect(split.items[0]).toMatchObject({ handle: "row1", kind: "command", options: ["approve", "reject"] });
	});
});

describe("decideBotPending (matriz)", () => {
	const item = commandItem("pnpm test");
	it("os dois aprovam com confiança alta -> aprova sozinho", () => {
		expect(decideBotPending({ ...base, item, proposal: proposal("approve"), jev: jevYes }).action).toBe("auto-approve");
	});
	it("os dois recusam (claramente fora do pedido) -> recusa sozinho", () => {
		const out = decideBotPending({ ...base, item, proposal: proposal("reject"), jev: { withinScope: 0.05, reversible: 0.9, harmlessOutward: 0.9 } });
		expect(out.action).toBe("auto-reject");
	});
	it("divergem -> usuário", () => {
		expect(decideBotPending({ ...base, item, proposal: proposal("approve"), jev: { ...jevYes, withinScope: 0.3 } })).toEqual({ action: "relay", why: "disagree" });
		expect(decideBotPending({ ...base, item, proposal: proposal("reject"), jev: jevYes })).toEqual({ action: "relay", why: "disagree" });
	});
	it("Jev incerto sobre reversibilidade -> usuário", () => {
		expect(decideBotPending({ ...base, item, proposal: proposal("approve"), jev: { ...jevYes, reversible: 0.5 } }).action).toBe("relay");
	});
	it("confiança baixa do orquestrador -> usuário", () => {
		expect(decideBotPending({ ...base, item, proposal: proposal("approve", 0.5), jev: jevYes })).toEqual({ action: "relay", why: "low-confidence" });
	});
	it("bloqueio fixo -> sempre o usuário", () => {
		const denied = buildBotPendingItem({ rowId: "r", role: "confirm", content: confirmCard({ devApproval: { kind: "command", command: "rm -rf /", cwd: "/w" } }) })!;
		expect(decideBotPending({ ...base, item: denied, proposal: proposal("approve"), jev: jevYes })).toEqual({ action: "relay", why: "hard-deny" });
		expect(decideBotPending({ ...base, item: denied, proposal: proposal("reject"), jev: { withinScope: 0, reversible: 0, harmlessOutward: 0 } })).toEqual({ action: "relay", why: "hard-deny" });
	});
	it("MCP irreversível -> sempre o usuário", () => {
		const mcp = buildBotPendingItem({ rowId: "r", role: "confirm", content: confirmCard({ description: "x" }), intent: { action: "mcp-call", actionClass: "irreversible" } })!;
		expect(decideBotPending({ ...base, item: mcp, proposal: proposal("approve"), jev: jevYes })).toEqual({ action: "relay", why: "irreversible" });
	});
	it("MCP reversível com acordo -> automático", () => {
		const mcp = buildBotPendingItem({ rowId: "r", role: "confirm", content: confirmCard({ description: "x" }), intent: { action: "mcp-call", actionClass: "write" } })!;
		expect(decideBotPending({ ...base, item: mcp, proposal: proposal("approve"), jev: jevYes }).action).toBe("auto-approve");
	});
	it("Jev indisponível -> usuário", () => {
		expect(decideBotPending({ ...base, item, proposal: proposal("approve"), jev: null })).toEqual({ action: "relay", why: "jev-unavailable" });
	});
	it("configuração desligada -> usuário", () => {
		expect(decideBotPending({ ...base, enabled: false, item, proposal: proposal("approve"), jev: jevYes })).toEqual({ action: "relay", why: "setting-off" });
	});
	it("cadeia sem humano -> comportamento de hoje (usuário)", () => {
		expect(decideBotPending({ ...base, unattended: true, item, proposal: proposal("approve"), jev: jevYes })).toEqual({ action: "relay", why: "unattended" });
	});
	it("sem proposta -> usuário", () => {
		expect(decideBotPending({ ...base, item, proposal: null, jev: jevYes })).toEqual({ action: "relay", why: "no-proposal" });
	});
});

describe("decideBotQuestionnaire", () => {
	const item = buildBotPendingItem({
		rowId: "q1",
		role: "questionnaire",
		content: JSON.stringify({ v: 1, kind: "questionnaire", questionnaireId: "qq", title: "Qual?", status: "pending", items: [{ name: "env", prompt: "Ambiente", required: true, choices: [{ value: "dev" }, { value: "prod" }] }] }),
	})!;
	it("responde sozinho com escolha válida", () => {
		expect(decideBotQuestionnaire({ ...base, item, answers: { env: "dev" } })).toEqual({ action: "auto-answer", answers: { env: "dev" } });
	});
	it("escolha inexistente, obrigatório vazio, desligado, sem humano -> usuário", () => {
		expect(decideBotQuestionnaire({ ...base, item, answers: { env: "staging" } }).action).toBe("relay");
		expect(decideBotQuestionnaire({ ...base, item, answers: {} }).action).toBe("relay");
		expect(decideBotQuestionnaire({ ...base, item, answers: null }).action).toBe("relay");
		expect(decideBotQuestionnaire({ ...base, enabled: false, item, answers: { env: "dev" } })).toEqual({ action: "relay", why: "setting-off" });
		expect(decideBotQuestionnaire({ ...base, unattended: true, item, answers: { env: "dev" } })).toEqual({ action: "relay", why: "unattended" });
	});
});

describe("configuração e nota de auditoria", () => {
	it("padrão desligado; liga e desliga sem perder outras chaves", () => {
		expect(readDecideForOtherBots(null)).toBe(false);
		expect(readDecideForOtherBots({})).toBe(false);
		const on = withDecideForOtherBots({ subagentModel: "a/b" }, true);
		expect(on).toEqual({ subagentModel: "a/b", decideForOtherBots: true });
		expect(readDecideForOtherBots(on)).toBe(true);
		expect(withDecideForOtherBots(on, false)).toEqual({ subagentModel: "a/b" });
	});

	it("nota e cartão de decisão automática", () => {
		const need = needFromCardRow({ rowId: "row1", conversationId: "conv", role: "confirm", content: confirmCard({ devApproval: { kind: "command", command: "pnpm test", cwd: "/w" } }) })!;
		const card = buildAutoDecisionCard({ botMessageId: "m", botId: "b", botName: "Dev", deciderName: "Principal", decision: "approved", subject: "pnpm test", reason: "roda só os testes", withJev: true, need });
		expect(autoDecisionNote(card)).toBe("Aprovado por Principal + Jev: pnpm test — roda só os testes");
		expect(autoDecisionNote({ ...card, decision: "rejected" })).toMatch(/^Recusado por Principal \+ Jev:/);
		expect(parseBotAutoDecisionCard(serializeBotLinkCard(card))).toMatchObject({ status: "queued", decision: "approved", need: { cardId: "row1" } });
	});
});
