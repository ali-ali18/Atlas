// Caso obrigatório da F8.1 (05-fases, "Página enorme e feed infinito"): um vídeo com 1.000 comentários em que a resposta
// depende do comentário nº 870. O bot precisa acertar SEM estourar a janela: o maior pedido ao modelo fica muito abaixo do
// tamanho da lista inteira. Dois caminhos: busca na VM + carregar mais, e o arquivo lido em blocos por ajudantes.
import { describe, expect, it } from "vitest";
import { defineCapability } from "../define-capability.js";
import type { Ports } from "../../ports/index.js";
import type { HelperResult } from "../../ports/helpers.js";
import { FakeHelpers } from "../../presets/fakes.js";
import { call, kernelHarness, reply } from "../../testing/kernel-fakes.js";
import { FakeBrowser, commentsPage } from "./fake-browser.js";
import { createBrowserCapability } from "./index.js";

const URL = "https://video.example.test/watch?v=abc";
const ANSWER = "ATLAS-4242";
const approxTokens = (chars: number) => Math.ceil(chars / 4);

async function runScripted(turns: ReturnType<typeof reply>[], browser: FakeBrowser, helpers?: FakeHelpers) {
	const core = defineCapability({ id: "core", title: "Core", summary: "core tools", core: true, tools: [] });
	const h = kernelHarness(turns, { capabilities: [core, createBrowserCapability(helpers ? { helpers } : {})] });
	const result = await h.run({ ports: { ...h.ports, sandbox: browser } as Ports, input: { contextSections: [], history: [{ kind: "owner", text: `Abre ${URL} e me diz qual é o código de desconto do patrocinador (está num comentário).` }] } });
	const requestTokens = h.llm.requests.map((r) => approxTokens(JSON.stringify(r.messages).length + JSON.stringify(r.tools ?? []).length));
	return { h, result, maxRequestTokens: Math.max(...requestTokens), requestTokens };
}

describe("1.000 comentários, resposta no nº 870", () => {
	const page = commentsPage({ total: 1000, initial: 40, batch: 50, answerAt: 870, answer: `Sponsor update: the discount code is ${ANSWER}, valid until 30 November.` });
	const fullListTokens = approxTokens(page.sections[1]!.all.join("\n").length);

	it("a lista inteira passaria de 20 mil tokens (o caso é de verdade grande)", () => {
		expect(fullListTokens).toBeGreaterThan(20_000);
	});

	it("caminho 1: mapa, carrega mais, busca na VM e lê só o comentário certo", async () => {
		const browser = new FakeBrowser([page]);
		const { h, result, maxRequestTokens } = await runScripted(
			[
				reply({ calls: [call("c1", "use_capability", { id: "browser" })] }),
				reply({ calls: [call("c2", "browser_open", { url: URL })] }),
				reply({ calls: [call("c3", "browser_map", {})] }),
				reply({ calls: [call("c4", "browser_find", { query: "discount code", section: "s2" })] }),
				reply({ calls: [call("c5", "browser_load_more", { section: "s2", times: 10 })] }),
				reply({ calls: [call("c6", "browser_load_more", { section: "s2", times: 10 })] }),
				reply({ calls: [call("c7", "browser_find", { query: "discount code", section: "s2" })] }),
				reply({ calls: [call("c8", "browser_read", { section: "s2", from: 870, count: 1 })] }),
				reply({ text: `O código do patrocinador é ${ANSWER} (comentário 870), válido até 30 de novembro.` }),
			],
			browser,
		);
		expect(result.status).toBe("done");
		expect(result.text).toContain(ANSWER);
		const results = h.llm.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
		// A primeira busca (40 carregados) não achou; a segunda achou o nº 870.
		expect(results.find((t) => t.includes("0 match(es)"))).toBeDefined();
		expect(results.find((t) => t.includes("s2 #870"))).toContain(ANSWER);
		// O mapa disse o tamanho sem trazer a lista.
		expect(results.find((t) => t.includes("Sections:"))).toContain("40 loaded of ~1,000");
		// Janela: o maior pedido ao modelo é uma fração pequena da lista.
		expect(maxRequestTokens).toBeLessThan(fullListTokens * 0.25);
		expect(maxRequestTokens).toBeLessThan(6_000);
		// Nada foi lido além do necessário: só 1 item saiu em `browser.read`.
		expect(browser.sent).toHaveLength(1);
	});

	it("caminho 2: o arquivo inteiro é lido em blocos por ajudantes e o item 870 volta citado", async () => {
		const browser = new FakeBrowser([page]);
		const helpers = new FakeHelpers((task): HelperResult => {
			const hit = /^(\d+)\. (.*discount code.*)$/m.exec(task.context ?? "");
			return { status: "done", text: hit ? `${hit[1]}. "${hit[2]}"` : "none", sources: [], spentUsd: 0, untrustedRead: true };
		});
		const { h, result, maxRequestTokens } = await runScripted(
			[
				reply({ calls: [call("c1", "use_capability", { id: "browser" })] }),
				reply({ calls: [call("c2", "browser_open", { url: URL })] }),
				reply({ calls: [call("c3", "browser_map", {})] }),
				reply({ calls: [call("c4", "browser_digest", { section: "s2", question: "Which comment gives the sponsor discount code? Quote it." })] }),
				reply({ text: `O código é ${ANSWER}, no comentário 870.` }),
			],
			browser,
			helpers,
		);
		expect(result.status).toBe("done");
		const digest = h.llm.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content).find((t) => t.includes("File read in"))!;
		expect(digest).toContain(ANSWER);
		expect(digest).toContain("870.");
		expect(digest).toContain("Every item of the file (1-1000) was read.");
		// Vários blocos, cada um com memória própria; nenhum dos comentários passou pelo modelo principal.
		expect(helpers.calls[0]!.tasks.length).toBeGreaterThan(3);
		const covered = helpers.calls[0]!.tasks.map((t) => /^Items (\d+)-(\d+) of/.exec(t.context ?? "")!.slice(1).map(Number) as [number, number]);
		expect(covered[0]![0]).toBe(1);
		expect(covered.at(-1)![1]).toBe(1000);
		for (let i = 1; i < covered.length; i++) expect(covered[i]![0]).toBe(covered[i - 1]![1] + 1);
		expect(helpers.calls[0]!.tasks.every((t) => t.capabilities.length === 0)).toBe(true);
		expect(maxRequestTokens).toBeLessThan(fullListTokens * 0.25);
	});

	it("bloco que falha é dito como NÃO LIDO, nunca omitido", async () => {
		const browser = new FakeBrowser([page]);
		const helpers = new FakeHelpers((_task, index): HelperResult => (index === 2 ? { status: "failed", text: "", sources: [], spentUsd: 0, untrustedRead: false, error: "model overloaded" } : { status: "done", text: "none", sources: [], spentUsd: 0, untrustedRead: true }));
		const { h } = await runScripted(
			[
				reply({ calls: [call("c1", "use_capability", { id: "browser" })] }),
				reply({ calls: [call("c2", "browser_open", { url: URL })] }),
				reply({ calls: [call("c3", "browser_digest", { section: "s2", question: "Any discount code?" })] }),
				reply({ text: "Parte do arquivo não foi lida." }),
			],
			browser,
			helpers,
		);
		const digest = h.llm.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content).find((t) => t.includes("File read in"))!;
		expect(digest).toContain("NOT READ (helper failed: model overloaded)");
		expect(digest).toContain("1 block(s) failed");
	});
});
