import { describe, expect, it } from "vitest";
import { classifyDifficulty, countRequestSteps } from "./difficulty.js";

const tier = (text: string, extra: Partial<Parameters<typeof classifyDifficulty>[0]> = {}) =>
	classifyDifficulty({ routerText: text, lastUserText: text, ...extra }).tier;

describe("classificação de dificuldade por regras", () => {
	it("conversa e perguntas curtas são Fácil", () => {
		for (const text of ["oi, tudo bem?", "obrigado!", "o que é recursão em uma frase?", "qual a capital da França?"]) {
			expect(tier(text), text).toBe("easy");
		}
	});

	it("consulta de dados, arquivos, navegador e pesquisa são Média", () => {
		for (const text of [
			"quantos pedidos vencidos eu tenho em aberto?",
			"gera uma planilha com os clientes",
			"abre o site da receita e me diz o prazo",
			"pesquisa a previsão do tempo de amanhã",
			"lê o pdf que mandei",
		]) {
			expect(tier(text), text).toBe("medium");
		}
	});

	it("código, shell e desktop são Difícil", () => {
		for (const text of [
			"corrige o bug no repositório e abre um pull request",
			"roda um script bash pra renomear os arquivos",
			"abre o libreoffice na área de trabalho e arrasta o arquivo",
		]) {
			expect(tier(text), text).toBe("hard");
		}
	});

	it("pedido longo ou com várias etapas encadeadas é Difícil", () => {
		expect(tier("a".repeat(900))).toBe("hard");
		expect(tier("Primeiro leia o texto, depois resuma, em seguida traduza e por fim revise o tom")).toBe("hard");
		expect(tier("1. Leia\n2. Compare\n3. Conclua")).toBe("hard");
	});

	it("várias ferramentas independentes sobem para Difícil; o navegador sozinho não", () => {
		expect(tier("abre o site, pesquisa os preços, calcula a média da planilha em csv e baixa o relatório")).toBe("hard");
		expect(tier("abre o site e baixa o relatório")).toBe("medium");
	});

	it("anexos e conectores citados sobem para Média; dois conectores, Difícil", () => {
		expect(tier("o que é isso?", { hasFileAttachments: true })).toBe("medium");
		expect(tier("o que é isso?", { hasImageAttachments: true })).toBe("medium");
		expect(tier("resume pra mim", { connectorCount: 1 })).toBe("medium");
		expect(tier("resume pra mim", { connectorCount: 2 })).toBe("hard");
	});

	it("mensagem longa de conversa sobe para Média, mas rotina sem fala não", () => {
		const long = "conversa ".repeat(40);
		expect(tier(long)).toBe("medium");
		expect(tier(long, { unattended: true })).toBe("easy");
	});

	it("devolve um motivo curto, sem o texto do usuário", () => {
		const result = classifyDifficulty({ routerText: "corrige o bug no repositório", lastUserText: "corrige o bug no repositório" });
		expect(result).toEqual({ tier: "hard", reason: "group:dev" });
	});

	it("o contexto anterior (roteador) conta: 'sim' depois de um pedido de código continua Difícil", () => {
		expect(tier("sim\nfaz o commit no repositório", { lastUserText: "sim" })).toBe("hard");
	});
});

describe("countRequestSteps", () => {
	it("conta marcadores de sequência e itens de lista", () => {
		expect(countRequestSteps("faça isto")).toBe(0);
		expect(countRequestSteps("primeiro isso, depois aquilo")).toBe(2);
		expect(countRequestSteps("- a\n- b")).toBe(2);
	});
});

describe("palavra solta de assunto não sobe o nível", () => {
	it("citar api, e-mail, cofre, bots, rotinas ou imagens sem ação fica Fácil", () => {
		for (const text of ["o que é uma API?", "o que é um e-mail?", "para que serve um cofre de senhas?", "o que é uma rotina?", "o que é uma imagem vetorial?"]) {
			expect(tier(text), text).toBe("easy");
		}
	});
});
