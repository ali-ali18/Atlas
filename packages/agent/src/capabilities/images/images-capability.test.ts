import { describe, expect, it } from "vitest";
import { decide, type DecideInput } from "@workspace/shared";
import { FakeImages } from "../../presets/fakes.js";
import type { ToolContext } from "../../tools/types.js";
import type { Ports } from "../../ports/index.js";
import { createImagesCapability, GENERATE_IMAGE_DESCRIPTION, IMAGE_COUNT_MAX } from "./index.js";

// Relógio dos testes: não é usado pela tool, mas o contexto de tool pede `ports`.
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ runId: "run-img", ownerId: "owner-a", ports: {} as Ports, ...over });

function setup() {
	const fake = new FakeImages();
	const cap = createImagesCapability(fake.port);
	const tool = cap.tools.find((t) => t.name === "generate_image")!;
	return { fake, cap, tool };
}

const NOW = new Date("2026-11-09T12:00:00Z");
const policy = (over: Partial<DecideInput>): DecideInput => ({
	effect: "write_external",
	surface: "chat",
	ownerPresent: true,
	autonomy: "balanced",
	rules: [],
	taint: { untrustedReadInRun: false, argsCarryUntrusted: false },
	now: NOW,
	...over,
});

describe("capacidade images: forma", () => {
	it("é lazy, tem uma tool de escrita externa com egress e card de imagem", () => {
		const { cap, tool } = setup();
		expect(cap.id).toBe("images");
		expect(cap.core).toBe(false);
		expect(cap.cards).toEqual(["images"]);
		expect(cap.tools.map((t) => t.name)).toEqual(["generate_image"]);
		expect(tool).toMatchObject({ effect: "write_external", egress: true, trust: "trusted", endsTurn: false });
		expect(tool.confirm).toBeUndefined();
	});

	it("o índice curto é uma linha em inglês e as instruções pedem o caminho do modelo de imagem em português", () => {
		const { cap } = setup();
		expect(cap.summary.length).toBeLessThanOrEqual(160);
		expect(cap.instructions).toContain("Configurações › Modelos › Modelo para gerar imagens");
		expect(cap.instructions).toContain("NEW picture");
	});
});

describe("texto para o modelo: várias imagens seguidas (protegido, 60-agente)", () => {
	it("a descrição manda as chamadas seguidas e o comentário só depois da última", () => {
		const { tool } = setup();
		expect(tool.description).toContain("When several images are needed, make all generate_image calls back to back");
		expect(tool.description).toContain("write your comment only after the last one");
		expect(tool.description).toContain("text between calls splits the gallery");
	});
	it("a descrição segue em inglês e sem nomes internos para o dono", () => {
		expect(GENERATE_IMAGE_DESCRIPTION).not.toMatch(/[ãçéõ]/);
		expect(GENERATE_IMAGE_DESCRIPTION).not.toMatch(/legado|ShowImage|images event/i);
	});
});

describe("política: quem decide é a autonomia (igual ao legado)", () => {
	const { tool } = setup();
	const effect = tool.effect;

	it("Equilibrado (padrão) pede o cartão de aprovação antes de gerar", () => {
		expect(decide(policy({ effect, autonomy: "balanced" }))).toEqual({ kind: "approve", reason: expect.any(String) });
	});
	it("Sempre perguntar também pede", () => {
		expect(decide(policy({ effect, autonomy: "always_ask" })).kind).toBe("approve");
	});
	it("Autônomo gera direto", () => {
		expect(decide(policy({ effect, autonomy: "autonomous" }))).toEqual({ kind: "run", reason: undefined });
	});
	it("sem dono presente (agenda, rotina, subagente, bot a bot) a tool fica oculta, em qualquer autonomia", () => {
		for (const surface of ["agenda", "routine", "subagent", "bot_to_bot"] as const) {
			expect(decide(policy({ effect, surface, ownerPresent: false, autonomy: "autonomous" })).kind).toBe("hidden");
		}
		expect(decide(policy({ effect, ownerPresent: false, autonomy: "autonomous" })).kind).toBe("hidden");
	});
	it("com conteúdo não confiável lido no run, mesmo em Autônomo, pede aprovação (prompt injection não gasta sozinho)", () => {
		expect(decide(policy({ effect, autonomy: "autonomous", taint: { untrustedReadInRun: true, argsCarryUntrusted: false } })).kind).toBe("approve");
	});
	it("regra `deny` do dono esconde a tool", () => {
		expect(decide(policy({ effect, autonomy: "autonomous", action: { toolName: "generate_image" }, rules: [{ match: "generate_image", verdict: "deny" }] })).kind).toBe("hidden");
	});
});

describe("generate_image: validação dos argumentos", () => {
	it("aceita só prompt, count e aspectRatio; campo desconhecido falha com a lista do que é aceito", async () => {
		const { tool, fake } = setup();
		const out = await tool.run({ prompt: "gato", ownerId: "owner-b" }, ctx());
		expect(out).toMatchObject({ ok: false, error: expect.stringContaining("Unknown field(s) for generate_image: ownerId") });
		expect(out).toMatchObject({ hint: expect.stringContaining("Accepted fields: prompt, count, aspectRatio") });
		expect(fake.calls).toHaveLength(0);
	});
	it("prompt vazio, count fora do limite e proporção mal formada falham sem chamar o provedor", async () => {
		const { tool, fake } = setup();
		expect(await tool.run({ prompt: "   " }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("prompt") });
		expect(await tool.run({ prompt: "gato", count: IMAGE_COUNT_MAX + 1 }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("count") });
		expect(await tool.run({ prompt: "gato", count: 0 }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("count") });
		expect(await tool.run({ prompt: "gato", aspectRatio: "16x9" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("aspectRatio") });
		expect(fake.calls).toHaveLength(0);
	});
	it("o prompt chega aparado e o limite de tamanho vale", async () => {
		const { tool, fake } = setup();
		expect(await tool.run({ prompt: "x".repeat(4001) }, ctx())).toMatchObject({ ok: false });
		await tool.run({ prompt: "  gato astronauta  ", aspectRatio: "16:9" }, ctx());
		expect(fake.calls[0]).toMatchObject({ prompt: "gato astronauta", count: 1, aspectRatio: "16:9" });
	});
});

describe("generate_image: execução e resultado honesto", () => {
	it("gera no dono do run e devolve o id do artefato, com recibo e custo", async () => {
		const { tool, fake } = setup();
		const out = await tool.run({ prompt: "logo azul", count: 2 }, ctx({ ownerId: "owner-a", runId: "run-7" }));
		expect(fake.calls).toEqual([{ userId: "owner-a", runId: "run-7", prompt: "logo azul", count: 2 }]);
		expect(out).toMatchObject({ ok: true, receipt: { what: "2 images generated", where: "Chat", externalId: "img-1-1, img-1-2" } });
		expect(out.ok && out.summary).toContain("Artifact ids: img-1-1, img-1-2");
		expect(out.ok && out.summary).toContain("US$ 0.040");
	});
	it("sem custo informado, a resposta diz que não informou (não diz zero)", async () => {
		const { tool, fake } = setup();
		fake.costUsd = undefined;
		const out = await tool.run({ prompt: "gato" }, ctx());
		expect(out.ok && out.summary).toContain("Provider cost not reported.");
	});
	it("falha da porta vira ok:false com o motivo real, sem sucesso falso", async () => {
		const { tool, fake } = setup();
		fake.fail = "Imagem gerada inválida.";
		expect(await tool.run({ prompt: "gato" }, ctx())).toEqual({ ok: false, error: "Imagem gerada inválida." });
	});
	it("porta que não devolve imagem nenhuma não vira sucesso", async () => {
		const cap = createImagesCapability({ generate: async () => ({ images: [] }) });
		const tool = cap.tools[0]!;
		expect(await tool.run({ prompt: "gato" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("returned no picture") });
	});
	it("o escopo é o do run: dois donos geram em nome de cada um, sem misturar", async () => {
		const { tool, fake } = setup();
		await tool.run({ prompt: "a" }, ctx({ ownerId: "owner-a" }));
		await tool.run({ prompt: "b" }, ctx({ ownerId: "owner-b" }));
		expect(fake.calls.map((c) => c.userId)).toEqual(["owner-a", "owner-b"]);
	});
});
