import { describe, expect, it, vi } from "vitest";
import {
	RESULT_HEAD_CHARS,
	buildReferenceText,
	createResultStore,
	extractResultRef,
	referenceMode,
	resultStoreLimits,
	stripResultRef,
} from "./result-store.js";
import { buildClipNotice } from "../mcp/clip-notice.js";

const limits = { refChars: 1_000, stubChars: 5_000 };
const text = (chars: number) => "linha de resultado\n".repeat(Math.ceil(chars / 19)).slice(0, chars);

describe("L3: faixas do resultado por referência", () => {
	it("limites vêm do env, com padrão e piso (stub nunca abaixo de ref)", () => {
		expect(resultStoreLimits({})).toEqual({ refChars: 3_000, stubChars: 20_000 });
		expect(resultStoreLimits({ ATLAS_CONTEXT_REF_CHARS: "2000", ATLAS_CONTEXT_STUB_CHARS: "9000" })).toEqual({ refChars: 2_000, stubChars: 9_000 });
		expect(resultStoreLimits({ ATLAS_CONTEXT_REF_CHARS: "8000", ATLAS_CONTEXT_STUB_CHARS: "100" }).stubChars).toBe(8_000);
		expect(resultStoreLimits({ ATLAS_CONTEXT_REF_CHARS: "abc" }).refChars).toBe(3_000);
	});

	it("pequeno fica como está; médio ganha referência; grande vira stub", () => {
		const mode = (chars: number) => referenceMode({ tool: "web_extract", text: text(chars), ok: true, limits });
		expect(mode(900)).toBe("none");
		expect(mode(1_001)).toBe("ref");
		expect(mode(5_000)).toBe("ref");
		expect(mode(5_001)).toBe("stub");
	});

	it("erro, leitura de referência e tools de meta nunca viram referência", () => {
		for (const tool of ["artifact_read", "read_cached_result", "mcp_tool_search", "checkpoint_read", "show_image", "create_file"]) {
			expect(referenceMode({ tool, text: text(9_000), ok: true, limits })).toBe("none");
		}
		expect(referenceMode({ tool: "web_extract", text: text(9_000), ok: false, limits })).toBe("none");
	});

	it("resultado que já tem referência não é guardado de novo", () => {
		const once = buildReferenceText({ mode: "ref", tool: "web_extract", text: text(2_000), artifactId: "art-1" });
		expect(referenceMode({ tool: "web_extract", text: once, ok: true, limits })).toBe("none");
	});
});

describe("L3: texto que o modelo vê", () => {
	it("faixa média: texto inteiro mais UMA linha de referência que a higiene acha e tira", () => {
		const body = text(2_000);
		const out = buildReferenceText({ mode: "ref", tool: "web_extract", text: body, artifactId: "art-1" });
		expect(out.startsWith(body)).toBe(true);
		expect(extractResultRef(out)).toMatchObject({ id: "art-1", chars: 2_000 });
		expect(stripResultRef(out)).toBe(body.trimEnd());
		expect(out).toContain("artifact_read");
	});

	it("stub: id, contagem, começo curto e como reler; nada do resto", () => {
		const body = `${"A".repeat(RESULT_HEAD_CHARS)}${"SEGREDO-FINAL ".repeat(2_000)}`;
		const stub = buildReferenceText({ mode: "stub", tool: "web_extract", text: body, artifactId: "art-9" });
		expect(stub).toContain("web_extract returned");
		expect(stub).toContain(`${body.length} characters (1 lines)`);
		expect(stub).toContain("artifact:art-9");
		expect(stub).toContain("artifact_read");
		expect(stub).toContain("Head:");
		expect(stub.length).toBeLessThan(RESULT_HEAD_CHARS + 900);
		expect(stub).not.toContain("SEGREDO-FINAL");
		expect(extractResultRef(stub)).toMatchObject({ id: "art-9" });
	});

	it("stub preserva o aviso de corte do conector (L23) sem reescrevê-lo", () => {
		const full = JSON.stringify({ items: Array.from({ length: 800 }, (_, i) => ({ id: i, name: `item ${i}` })) });
		const clipped = `${full.slice(0, 7_000)}\n${buildClipNotice(full, 7_000)}`;
		const stub = buildReferenceText({ mode: "stub", tool: "connector_list", text: clipped, artifactId: "art-2" });
		expect(stub).toContain("[Result truncated: showing ~7000 of");
		expect(stub.match(/Result truncated/g)).toHaveLength(1);
	});

	it("o tamanho guardado menor que o texto aparece na linha", () => {
		const out = buildReferenceText({ mode: "ref", tool: "x", text: text(2_000), artifactId: "a", storedChars: 1_500 });
		expect(extractResultRef(out)?.chars).toBe(1_500);
	});
});

describe("L3: armazenamento", () => {
	it("guarda o texto inteiro e devolve a referência; falha ao guardar devolve o resultado como era", async () => {
		const persist = vi.fn(async () => "art-1");
		const store = createResultStore({ persist, limits });
		const body = text(7_000);
		const out = await store.reference({ tool: "web_extract", text: body, ok: true, step: 3 });
		expect(persist).toHaveBeenCalledWith({ tool: "web_extract", text: body, step: 3 });
		expect(out).toContain("artifact:art-1");
		expect(store.stored()).toBe(1);

		const failing = createResultStore({ persist: async () => null, limits });
		expect(await failing.reference({ tool: "web_extract", text: body, ok: true, step: 1 })).toBe(body);
		const throwing = createResultStore({ persist: async () => { throw new Error("disk full"); }, limits });
		expect(await throwing.reference({ tool: "web_extract", text: body, ok: true, step: 1 })).toBe(body);
	});

	it("resultado pequeno nem toca o armazenamento", async () => {
		const persist = vi.fn(async () => "x");
		const store = createResultStore({ persist, limits });
		expect(await store.reference({ tool: "web_extract", text: text(500), ok: true, step: 0 })).toHaveLength(500);
		expect(persist).not.toHaveBeenCalled();
	});

	it("limite por run: passado dele o resultado segue como sempre", async () => {
		const store = createResultStore({ persist: async () => "id", limits, maxPerRun: 2 });
		const body = text(2_000);
		await store.reference({ tool: "t", text: body, ok: true, step: 0 });
		await store.reference({ tool: "t", text: body, ok: true, step: 1 });
		expect(await store.reference({ tool: "t", text: body, ok: true, step: 2 })).toBe(body);
		expect(store.stored()).toBe(2);
	});

	it("acima de 400 mil caracteres guarda cortado e a linha diz o tamanho guardado", async () => {
		const persist = vi.fn(async (_input: { text: string }) => "big");
		const store = createResultStore({ persist, limits });
		const out = await store.reference({ tool: "t", text: "x".repeat(500_000), ok: true, step: 0 });
		expect(persist.mock.calls[0]![0].text).toHaveLength(400_000);
		expect(extractResultRef(out)?.chars).toBe(400_000);
	});
});

describe("limites padrão: resultado fica no contexto até ~20 mil caracteres", () => {
	const defaults = resultStoreLimits({});
	const body = (chars: number) => "x".repeat(chars);

	it("até 20 mil o texto segue inteiro (com a referência para reler depois da limpeza); acima, só prévia", () => {
		const input = (chars: number) => ({ tool: "mcp__erp__list", text: body(chars), ok: true, limits: defaults });
		expect(referenceMode(input(2_900))).toBe("none");
		expect(referenceMode(input(15_000))).toBe("ref");
		expect(referenceMode(input(20_000))).toBe("ref");
		expect(referenceMode(input(20_001))).toBe("stub");
		const whole = buildReferenceText({ mode: "ref", tool: "mcp__erp__list", text: body(15_000), artifactId: "a1" });
		expect(whole.startsWith(body(15_000))).toBe(true);
		expect(buildReferenceText({ mode: "stub", tool: "mcp__erp__list", text: body(25_000), artifactId: "a2" })).toContain("Head:");
	});
});
