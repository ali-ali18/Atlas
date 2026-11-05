import { describe, expect, it } from "vitest";
import { CARD_ICON_KEYS, CARD_PREVIEW_ROLES, cardKindOfContent, cardPreviewOf, isMarkerRole, jsonTextField } from "./card-preview";

// O servidor corta o `content` em 200 caracteres (`BOT_PREVIEW_MAX_CHARS`): os testes imitam isso.
const wire = (card: object): string => JSON.stringify({ v: 1, ...card }).slice(0, 200);

describe("jsonTextField", () => {
	it("lê campo de JSON truncado e desfaz escapes", () => {
		expect(jsonTextField('{"title":"Fatura \\"A\\"\\nok","x":"cort', "title")).toBe('Fatura "A" ok');
	});
	it("campo cortado no meio ou ausente = undefined", () => {
		expect(jsonTextField('{"title":"Fatu', "title")).toBeUndefined();
		expect(jsonTextField("{}", "title")).toBeUndefined();
		expect(jsonTextField('{"title":"   "}', "title")).toBeUndefined();
	});
});

describe("cardPreviewOf", () => {
	it("papel que não é de card = null (texto normal)", () => {
		expect(cardPreviewOf("assistant", "Oi, **tudo bem**?")).toBeNull();
		expect(cardPreviewOf("user", '{"title":"x"}')).toBeNull();
		expect(cardPreviewOf("bot-link", "{}")).toBeNull();
	});

	it("gráfico: título do spec, sem pegar título de linha de dados", () => {
		expect(cardPreviewOf("chart", wire({ kind: "chart", chartId: "c1", spec: { type: "line", title: "Vendas por mês", x: "mes", series: [], data: [] } }))).toEqual({ icon: "chart", title: "Vendas por mês" });
		expect(cardPreviewOf("chart", '{"v":1,"kind":"chart","spec":{"type":"bar","data":[{"title":"X"}]}}')).toEqual({ icon: "chart", title: "Gráfico" });
	});

	it("painel: título; sem título = Painel", () => {
		expect(cardPreviewOf("page", wire({ kind: "page", pageId: "p1", revision: 2, title: "Resumo financeiro", action: "created", sourceCount: 1 }))).toEqual({ icon: "panel", title: "Resumo financeiro" });
		expect(cardPreviewOf("page", "{")).toEqual({ icon: "panel", title: "Painel" });
	});

	it("arquivo: nome e ícone pela extensão", () => {
		const file = (filename: string) => wire({ kind: "file", artifactId: "a", filename, mime: "x", size: 1, format: "text", version: 1 });
		expect(cardPreviewOf("file", file("relatorio.pdf"))).toEqual({ icon: "document", title: "relatorio.pdf" });
		expect(cardPreviewOf("file", file("Contas.XLSX"))).toEqual({ icon: "spreadsheet", title: "Contas.XLSX" });
		expect(cardPreviewOf("file", file("deck.pptx"))).toEqual({ icon: "presentation", title: "deck.pptx" });
		expect(cardPreviewOf("file", "{")).toEqual({ icon: "document", title: "Documento" });
	});

	it("imagens: legenda, quantidade ou rótulo", () => {
		const items = (n: number) => Array.from({ length: n }, (_, i) => ({ artifactId: `a${i}`, mime: "image/png", width: 1, height: 1 }));
		expect(cardPreviewOf("images", JSON.stringify({ v: 1, kind: "images", origin: "assistant", items: items(1), caption: "Logo novo" }))).toEqual({ icon: "images", title: "Logo novo" });
		expect(cardPreviewOf("images", JSON.stringify({ v: 1, kind: "images", origin: "assistant", items: items(3) }))).toEqual({ icon: "images", title: "3 imagens" });
		expect(cardPreviewOf("images", wire({ kind: "images", origin: "assistant", items: items(5) }))).toEqual({ icon: "images", title: "Imagem" });
	});

	it("rotina: título, lista e proposta", () => {
		expect(cardPreviewOf("routine", wire({ kind: "routine", action: "created", title: "Resumo da manhã", routineId: "r1" }))).toEqual({ icon: "routine", title: "Resumo da manhã" });
		expect(cardPreviewOf("routine", wire({ kind: "routine", action: "listed", items: [{ title: "A" }] }))).toEqual({ icon: "routine", title: "Rotinas" });
		expect(cardPreviewOf("routine", wire({ kind: "routine", action: "updated" }))).toEqual({ icon: "routine", title: "Rotina" });
		expect(cardPreviewOf("routine-proposal", wire({ kind: "routine-proposal", proposalId: "p", mode: "suggest", status: "pending", spec: { name: "Conferir fatura", prompt: "x" } }))).toEqual({ icon: "routine", title: "Conferir fatura" });
	});

	it("tarefas: contagem quando o JSON veio inteiro, rótulo quando cortado", () => {
		const items = [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }];
		expect(cardPreviewOf("task-list", JSON.stringify({ v: 1, kind: "task-list", runId: "r", items }))).toEqual({ icon: "tasks", title: "Tarefas · 1/2 concluídas" });
		expect(cardPreviewOf("task-list", wire({ kind: "task-list", runId: "r", items: Array.from({ length: 20 }, () => ({ content: "passo longo da lista", status: "pending" })) }))).toEqual({ icon: "tasks", title: "Tarefas" });
	});

	it("questionário: pergunta do primeiro item, senão título, senão rótulo", () => {
		expect(cardPreviewOf("questionnaire", wire({ kind: "questionnaire", questionnaireId: "q", title: "Conhecendo você", items: [{ name: "n", prompt: "Pra que você me criou?" }], status: "pending" }))).toEqual({ icon: "questionnaire", title: "Pra que você me criou?" });
		expect(cardPreviewOf("questionnaire", wire({ kind: "questionnaire", questionnaireId: "q", title: "Conhecendo você", description: "d".repeat(300) }))).toEqual({ icon: "questionnaire", title: "Conhecendo você" });
		expect(cardPreviewOf("questionnaire", "{")).toEqual({ icon: "questionnaire", title: "Questionário" });
	});

	it("subagentes, login, pedido de aprovação", () => {
		expect(cardPreviewOf("subagents", wire({ kind: "subagents", groupId: "g", tasks: [{ taskIndex: 0, title: "Pesquisar preços", goal: "g" }] }))).toEqual({ icon: "subagents", title: "Pesquisar preços" });
		expect(cardPreviewOf("subagents", wire({ kind: "subagents", groupId: "g", tasks: [{ taskIndex: 0, goal: "Comparar planos" }] }))).toEqual({ icon: "subagents", title: "Comparar planos" });
		expect(cardPreviewOf("login", wire({ kind: "login", loginId: "l", site: "github.com", url: "https://github.com", status: "pending" }))).toEqual({ icon: "login", title: "Login em github.com" });
		expect(cardPreviewOf("login", "{")).toEqual({ icon: "login", title: "Login" });
		expect(cardPreviewOf("confirm", wire({ kind: "confirm", confirmId: "c", title: "Executar este comando?", status: "pending" }))).toEqual({ icon: "approval", title: "Executar este comando?" });
		expect(cardPreviewOf("confirm", "{")).toEqual({ icon: "approval", title: "Pedido de aprovação" });
	});

	it("habilidade: título, lista, proposta", () => {
		expect(cardPreviewOf("skill", wire({ kind: "skill", action: "created", title: "Resumir e-mails" }))).toEqual({ icon: "skill", title: "Resumir e-mails" });
		expect(cardPreviewOf("skill", wire({ kind: "skill", action: "listed", items: [{ title: "A" }] }))).toEqual({ icon: "skill", title: "Habilidades" });
		expect(cardPreviewOf("skill", wire({ kind: "skill", action: "cleaned" }))).toEqual({ icon: "skill", title: "Habilidade" });
		expect(cardPreviewOf("skill-proposal", wire({ kind: "skill-proposal", proposalId: "p", action: "create", status: "pending", name: "Revisar PR" }))).toEqual({ icon: "skill", title: "Revisar PR" });
	});

	it("código, compactação, agente e perfil", () => {
		expect(cardPreviewOf("code-run", wire({ kind: "code-run", callId: "c", code: "print(1)", status: "ok" }))).toEqual({ icon: "code", title: "Código executado" });
		expect(cardPreviewOf("compaction", "{}")).toEqual({ icon: "compaction", title: "Conversa compactada" });
		expect(cardPreviewOf("bot-proposal", wire({ kind: "bot-proposal", proposalId: "p", status: "pending", name: "Contador" }))).toEqual({ icon: "agent", title: "Contador" });
		expect(cardPreviewOf("bot-proposal", "{")).toEqual({ icon: "agent", title: "Novo agente" });
		expect(cardPreviewOf("bot-profile", wire({ kind: "bot-profile", proposalId: "p", botId: "b", before: { name: "Cookie" }, status: "pending" }))).toEqual({ icon: "profile", title: "Atualizar perfil de Cookie" });
		expect(cardPreviewOf("bot-profile", "{")).toEqual({ icon: "profile", title: "Atualizar perfil" });
	});

	it("payload faltando ou lixo: sempre devolve ícone e título não vazio", () => {
		for (const role of CARD_PREVIEW_ROLES) {
			for (const content of ["", "{", "não é json", "[]", "null"]) {
				const preview = cardPreviewOf(role, content);
				expect(preview, `${role} / ${content}`).not.toBeNull();
				expect(preview?.title.length).toBeGreaterThan(0);
				expect(CARD_ICON_KEYS).toContain(preview?.icon);
			}
		}
	});

	it("título longo passa inteiro (o corte é do home-list)", () => {
		const title = "Relatório ".repeat(40).trim();
		expect(cardPreviewOf("page", JSON.stringify({ v: 1, kind: "page", title }))?.title).toBe(title);
	});
});

describe("isMarkerRole", () => {
	it("marcadores internos", () => {
		for (const role of ["tool-budget", "jev-status", "provider-fallback", "revised-draft"]) expect(isMarkerRole(role)).toBe(true);
		expect(isMarkerRole("assistant")).toBe(false);
		expect(isMarkerRole("chart")).toBe(false);
	});
});

describe("card reconhecido pelo conteúdo (papel não diz que é card)", () => {
	// Caso do print do dono: questionário cortado em 200 caracteres.
	const printed = JSON.stringify({ v: 1, kind: "questionnaire", questionnaireId: "q1", title: "Preciso de algumas informações para montar o plano da sua viagem", status: "pending", items: [{ id: "a", question: "Para onde?" }] }).slice(0, 200);

	it("questionário truncado em 200 caracteres com papel assistant", () => {
		const preview = cardPreviewOf("assistant", printed);
		expect(preview).toEqual({ icon: "questionnaire", title: "Preciso de algumas informações para montar o plano da sua viagem" });
	});

	it("título cortado: rótulo do tipo, nunca JSON", () => {
		expect(cardPreviewOf("assistant", '{"v":1,"kind":"questionnaire","questionnai')).toEqual({ icon: "questionnaire", title: "Questionário" });
	});

	it("kind desconhecido ou cortado: rótulo genérico sem JSON", () => {
		expect(cardPreviewOf("assistant", '{"v":1,"kind":"novo-tipo","x":1}')).toEqual({ icon: "generic", title: "Card" });
		expect(cardPreviewOf("assistant", '{"v":1,"kin')).toEqual({ icon: "generic", title: "Card" });
		expect(cardPreviewOf("assistant", '{"v":2,"x":1}')).toEqual({ icon: "generic", title: "Card" });
	});

	it("texto normal não é card", () => {
		expect(cardPreviewOf("assistant", "Oi! Segue o plano")).toBeNull();
		expect(cardPreviewOf("assistant", '{"title":"x"}')).toBeNull();
	});

	it("cardKindOfContent", () => {
		expect(cardKindOfContent('{"v":1,"kind":"page","t')).toBe("page");
		expect(cardKindOfContent("texto")).toBeNull();
	});
});
