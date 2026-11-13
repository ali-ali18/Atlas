import { describe, expect, it } from "vitest";
import { createCapabilityRegistry, defineCapability } from "../capabilities/index.js";
import { fakeTool } from "../capabilities/fixtures.js";
import { CHANNELS_PROMPT } from "../channels/system-prompt-channels.js";
import { scanText } from "../hygiene.test.js";
import { kernelHarness, reply } from "../testing/kernel-fakes.js";
import { WORK_CONTRACT_PROMPT, buildStablePrompt } from "./work-contract.js";

// Linha de base MEDIDA (caracteres). O prompt estável não pode crescer mais de 15% sem decisão
// explícita: suba a constante no mesmo commit, com o motivo (custo de tokens em todo run).
const BASELINE_WORK_CONTRACT_CHARS = 1274;
const BASELINE_STABLE_CHARS = 1861; // contrato + canais, sem índice de capacidades
const GROWTH_LIMIT = 1.15;

describe("contrato de trabalho no prompt (F1.11): uma instrução-chave por seção", () => {
	const p = WORK_CONTRACT_PROMPT;
	it.each([
		["antecipa: conteúdo, não índice", /Deliver the content, not an index/],
		["antecipa: resumo diz o que cada um pede, valores e prazos, sem promoção", /what each sender asks, with amounts and deadlines, and leaves promotions out unless asked/],
		["acompanha: agenda sozinho e em silêncio", /schedule it yourself with the agenda tools, silently/],
		["formato certo: arquivo, tabela ou painel, card", /file; comparisons in a table or panel; products in a card/],
		["formato certo: confere o próprio arquivo", /Check your own file before delivering/],
		["pesquisa: proporcional, várias fontes, URLs, o que não confirmou", /Research in proportion[^]*several sources, URLs cited, and what you could not confirm/],
		["decide sozinho, pergunta só na fronteira, uma pergunta com padrão", /ask only at the boundary: money, sending, public links, credentials, anything irreversible\. Ask one question with a suggested default/],
		["anotações: caderno vs memória", /notebook for the working state of this task, memory for lasting facts/],
		["não insiste: recusou ou ignorou, larga; falha reportada está fechada", /Never insist\. Once the owner declined or ignored an offer, drop it\. A failed task, honestly reported, is finished/],
		["linguagem simples: sem nomes de tool, ids ou campos", /Never show the owner tool names, ids or internal fields/],
		["locale: idioma do bot, datas e moeda do dono, sem assumir país", /Answer in the bot's language\. Take dates, currency and time zone from the owner's locale; never assume a country/],
	])("%s", (_name, re) => {
		expect(p).toMatch(re);
	});

	it("tem as nove seções e o título", () => {
		expect(p.startsWith("## Work contract\n")).toBe(true);
		expect(p.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(9);
	});
});

describe("orçamento de tamanho", () => {
	it("o contrato de trabalho não passa de 15% da linha de base", () => {
		expect(WORK_CONTRACT_PROMPT.length).toBeLessThanOrEqual(Math.floor(BASELINE_WORK_CONTRACT_CHARS * GROWTH_LIMIT));
	});
	it("o prompt estável (contrato + canais) não passa de 15% da linha de base", () => {
		expect(buildStablePrompt().length).toBeLessThanOrEqual(Math.floor(BASELINE_STABLE_CHARS * GROWTH_LIMIT));
	});
	it("a linha de base não está defasada para baixo (encolher também pede atualizar a constante)", () => {
		expect(buildStablePrompt().length).toBeGreaterThanOrEqual(BASELINE_STABLE_CHARS * 0.7);
	});
});

describe("genérico e sem termos do dono", () => {
	it("passa na guarda de higiene e não assume país, moeda nem marca", () => {
		const all = buildStablePrompt();
		expect(scanText(all)).toEqual([]);
		for (const term of ["Brazil", "Brasil", "BRL", "R$", "pt-BR"]) expect(all.toLowerCase()).not.toContain(term.toLowerCase());
	});
	it("não tem data nem nonce (prefixo estável)", () => {
		expect(buildStablePrompt()).not.toMatch(/\b20\d\d-\d\d-\d\d\b|\bnonce\b|[0-9a-f]{16,}/i);
	});
});

describe("montagem", () => {
	const cap = (id: string, summary: string) => defineCapability({ id, title: id, summary, tools: [fakeTool(`${id}_read`)] });
	const registry = createCapabilityRegistry([cap("mail", "Read and draft email."), cap("agenda", "Reminders and watches.")]);

	it("é determinística e na ordem contrato, canais, capacidades", () => {
		const a = buildStablePrompt(registry);
		expect(buildStablePrompt(registry)).toBe(a);
		const [i1, i2, i3] = [a.indexOf(WORK_CONTRACT_PROMPT), a.indexOf(CHANNELS_PROMPT), a.indexOf("## Capabilities")];
		expect(i1).toBe(0);
		expect(i2).toBeGreaterThan(i1);
		expect(i3).toBeGreaterThan(i2);
	});
	it("sem capacidades carregáveis não abre a seção", () => {
		expect(buildStablePrompt()).not.toContain("## Capabilities");
		expect(buildStablePrompt()).toBe(`${WORK_CONTRACT_PROMPT}\n\n${CHANNELS_PROMPT}`);
	});
});

describe("ligação no kernel", () => {
	it("sem stableSystem o kernel manda o prompt montado; com stableSystem, o dado", async () => {
		const assembled = kernelHarness([reply({ text: "ok" })]);
		await assembled.run({ input: { contextSections: [], history: [{ kind: "owner", text: "oi" }] } });
		expect(assembled.llm.requests[0]?.messages[0]).toEqual({ role: "system", content: buildStablePrompt(assembled.registry) });

		const given = kernelHarness([reply({ text: "ok" })]);
		await given.run();
		expect(given.llm.requests[0]?.messages[0]).toEqual({ role: "system", content: "SYSTEM" });
	});
});
