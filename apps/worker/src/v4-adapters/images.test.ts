/**
 * Imagens do v4 no worker (F9): o evento `images` tem o formato do legado, gerações seguidas saem como eventos iguais
 * (o chat agrupa num baralho), cada imagem é do dono do run e a falta de modelo diz como configurar.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/images.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComputerUseEvent } from "@workspace/shared";
import { buildV4Registry } from "./index.js";
import { createV4Images, IMAGE_MODEL_MISSING_ERROR, type V4ImagesDeps } from "./images.js";
import { fakeAdapterDeps } from "./index.test.js";

type Persisted = { userId: string; runId: string; conversationId: string | null; kind: string; mime: string; bytes: Uint8Array; meta: Record<string, unknown> };

/** Dependências falsas: um arquivo por imagem pedida, cartão gravado na conversa e evento ao vivo. */
function fakes(options: { providerError?: Error; costUsd?: number; cardFails?: boolean } = {}) {
	const generated: Array<{ apiKey: string; model: string; prompt: string; n: number; aspectRatio?: string }> = [];
	const persisted: Persisted[] = [];
	const cards: Array<{ conversationId: string; event: ComputerUseEvent }> = [];
	const live: ComputerUseEvent[] = [];
	let seq = 0;
	const deps: V4ImagesDeps = {
		generate: (async (params: { apiKey: string; model: string; prompt: string; n: number; aspectRatio?: string }) => {
			generated.push(params);
			if (options.providerError) throw options.providerError;
			const images = Array.from({ length: params.n }, () => ({ bytes: Buffer.from("raw"), mime: "image/png" }));
			return { images, ...(options.costUsd !== undefined && { costUsd: options.costUsd }) };
		}) as V4ImagesDeps["generate"],
		process: (async () => ({ bytes: Buffer.from("processed"), mime: "image/png" as const, width: 1024, height: 768 })) as V4ImagesDeps["process"],
		persistArtifact: (async (input: Persisted) => {
			persisted.push(input);
			seq += 1;
			return { id: `art-${seq}` };
		}) as V4ImagesDeps["persistArtifact"],
		persistCard: async (conversationId, event) => {
			if (options.cardFails) throw new Error("banco fora do ar");
			cards.push({ conversationId, event });
		},
	};
	return { deps, generated, persisted, cards, live };
}

const config = { apiKey: "sk-or-segredo-de-teste", model: "image/model-x" };

test("o evento emitido tem o formato do legado: type images, origin assistant, items com artifactId, mime, width e height", async () => {
	const f = fakes();
	const port = createV4Images({ scope: { conversationId: "conv-1", emit: (event) => { f.live.push(event); } }, config, deps: f.deps });
	const out = await port.generate("user-a", "run-1", { prompt: "logo azul", count: 1 });
	const expected = { type: "images", origin: "assistant", items: [{ artifactId: "art-1", mime: "image/png", width: 1024, height: 768 }] };
	assert.deepEqual(f.live, [expected]);
	assert.deepEqual(f.cards, [{ conversationId: "conv-1", event: expected }]);
	assert.deepEqual(out.images, [{ artifactId: "art-1", mime: "image/png", width: 1024, height: 768 }]);
});

test("duas gerações seguidas saem como dois eventos images, sem nenhum outro tipo no meio (o chat as agrupa)", async () => {
	const f = fakes();
	const port = createV4Images({ scope: { conversationId: "conv-1", emit: (event) => { f.live.push(event); } }, config, deps: f.deps });
	await port.generate("user-a", "run-1", { prompt: "um", count: 2 });
	await port.generate("user-a", "run-1", { prompt: "dois", count: 1 });
	assert.deepEqual(f.live.map((event) => event.type), ["images", "images"]);
	assert.deepEqual(f.cards.map((card) => card.event.type), ["images", "images"]);
	const second = f.live[1];
	assert.ok(second?.type === "images");
	assert.deepEqual(second.items.map((item) => item.artifactId), ["art-3"]);
});

test("cada imagem vira artefato do dono do run, com o meta do legado (origem gerada)", async () => {
	const f = fakes();
	const port = createV4Images({ scope: { conversationId: "conv-1", emit: () => undefined }, config, deps: f.deps });
	await port.generate("user-a", "run-1", { prompt: "gato", count: 1, aspectRatio: "16:9" });
	assert.equal(f.persisted.length, 1);
	assert.deepEqual(f.persisted[0], {
		bytes: Buffer.from("processed"),
		userId: "user-a",
		runId: "run-1",
		conversationId: "conv-1",
		kind: "image",
		mime: "image/png",
		meta: { mime: "image/png", width: 1024, height: 768, bytes: Buffer.from("processed").byteLength, source: "generated", origin: "assistant" },
	});
	assert.deepEqual(f.generated[0], { apiKey: config.apiKey, model: config.model, prompt: "gato", n: 1, aspectRatio: "16:9" });
});

test("outro dono não herda o artefato: o run de B grava em nome de B", async () => {
	const f = fakes();
	const port = createV4Images({ scope: { conversationId: null, emit: () => undefined }, config, deps: f.deps });
	await port.generate("user-a", "run-a", { prompt: "a", count: 1 });
	await port.generate("user-b", "run-b", { prompt: "b", count: 1 });
	assert.deepEqual(f.persisted.map((row) => row.userId), ["user-a", "user-b"]);
	assert.deepEqual(f.persisted.map((row) => row.conversationId), [null, null]);
});

test("sem modelo de imagem: não chama o provedor e a mensagem manda configurar, com o caminho em português", async () => {
	const f = fakes();
	const port = createV4Images({ scope: { conversationId: "conv-1", emit: () => undefined }, deps: f.deps });
	await assert.rejects(port.generate("user-a", "run-1", { prompt: "gato", count: 1 }), (error: Error) => error.message === IMAGE_MODEL_MISSING_ERROR);
	assert.equal(f.generated.length, 0);
	assert.match(IMAGE_MODEL_MISSING_ERROR, /Configurações › Modelos › Modelo para gerar imagens/);
});

test("erro do provedor sai sem a chave do dono", async () => {
	const f = fakes({ providerError: new Error(`recusado com a chave ${config.apiKey}`) });
	const port = createV4Images({ scope: { conversationId: "conv-1", emit: () => undefined }, config, deps: f.deps });
	await assert.rejects(port.generate("user-a", "run-1", { prompt: "gato", count: 1 }), (error: Error) => {
		assert.ok(!error.message.includes(config.apiKey));
		assert.match(error.message, /recusado/);
		return true;
	});
	assert.equal(f.persisted.length, 0);
});

test("falha ao gravar o cartão não desfaz as imagens: o evento ao vivo sai e a falha vai ao log", async () => {
	const f = fakes({ cardFails: true });
	const logs: string[] = [];
	const live: ComputerUseEvent[] = [];
	const port = createV4Images({ scope: { conversationId: "conv-1", emit: (event) => { live.push(event); }, log: (message) => logs.push(message) }, config, deps: f.deps });
	const out = await port.generate("user-a", "run-1", { prompt: "gato", count: 1 });
	assert.equal(out.images.length, 1);
	assert.equal(live[0]?.type, "images");
	assert.match(logs[0] ?? "", /banco fora do ar/);
});

test("custo do provedor passa adiante; sem ele, não aparece como zero", async () => {
	const withCost = createV4Images({ scope: { conversationId: null, emit: () => undefined }, config, deps: fakes({ costUsd: 0.04 }).deps });
	assert.equal((await withCost.generate("user-a", "r", { prompt: "x", count: 1 })).costUsd, 0.04);
	const without = createV4Images({ scope: { conversationId: null, emit: () => undefined }, config, deps: fakes().deps });
	assert.equal((await without.generate("user-a", "r", { prompt: "x", count: 1 })).costUsd, undefined);
});

test("no registro: run com dono e modelo tem a capacidade images; run sem dono não a monta", async () => {
	const deps = fakeAdapterDeps();
	const withOwner = await buildV4Registry({ runId: "run-1", userId: "user-a", conversationId: "conv-1", unattended: false, notes: {} as never, emit: () => undefined, deps, imageGeneration: config, makeHelpers: () => ({ runAll: async () => [] }) as never });
	assert.ok(withOwner.registry.ids().includes("images"));
	assert.ok(withOwner.registry.toolByName("generate_image"));
	const unattended = await buildV4Registry({ runId: "run-2", userId: "user-a", conversationId: "conv-1", unattended: true, notes: {} as never, emit: () => undefined, deps, imageGeneration: config, makeHelpers: () => ({ runAll: async () => [] }) as never });
	assert.ok(!unattended.registry.ids().includes("images"));
	assert.ok(!unattended.registry.toolByName("generate_image"));
	assert.ok(unattended.unavailable.includes("images"));
});
