import assert from "node:assert/strict";
import { test } from "node:test";
import { imageVisionForRun } from "./image-vision.js";

const png = Buffer.from("imagem de teste");

test("imagem do dono vai ao descritor uma vez; descrição fica em cache", async () => {
	let description: string | undefined;
	let completions = 0;
	const vision = imageVisionForRun({
		userId: "user-a", apiKey: "test-key", fallbackModel: "vision/model",
		makeModelCopy: async (bytes) => { assert.deepEqual(bytes, png); return "data:image/png;base64,dGVzdA=="; },
		loadArtifact: async (id, userId) => {
			assert.equal(id, "image-a");
			assert.equal(userId, "user-a");
			return { id, kind: "image", runId: null, conversationId: null, createdAt: new Date(0), bytes: png, meta: { mime: "image/png", ...(description ? { description } : {}) } };
		},
		saveDescription: async (id, userId, text) => {
			assert.equal(id, "image-a");
			assert.equal(userId, "user-a");
			description = text;
			return true;
		},
		complete: async (params) => {
			completions++;
			const user = params.messages[1];
			assert.equal(user?.role, "user");
			assert.ok(Array.isArray(user.content));
			assert.equal(user.content[1]?.type, "image_url");
			assert.match(user.content[1]?.type === "image_url" ? user.content[1].image_url.url : "", /^data:image\/(jpeg|png);base64,/);
			return { message: { role: "assistant", content: "Uma flor azul" }, model: params.model, usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, costUsd: 0.002 } };
		},
	});
	assert.match(await vision.loadUserImage("image-a") ?? "", /^data:image\//);
	assert.deepEqual(await vision.describeUserImage("image-a"), { description: "Uma flor azul", costUsd: 0.002 });
	assert.deepEqual(await vision.describeUserImage("image-a"), { description: "Uma flor azul" });
	assert.equal(completions, 1);
});

test("imagem fora do escopo e fallback desligado não chamam provedor", async () => {
	const vision = imageVisionForRun({
		userId: "user-b", apiKey: "test-key",
		loadArtifact: async () => null,
	});
	assert.equal(await vision.loadUserImage("image-a"), null);
	assert.deepEqual(await vision.describeUserImage("image-a"), { description: null, loadFailed: true });
});

test("describeUserImage sem usage.cost marca costUnknown (chamada feita, custo desconhecido)", async () => {
	const vision = imageVisionForRun({
		userId: "user-a", apiKey: "test-key", fallbackModel: "vision/model",
		makeModelCopy: async () => "data:image/png;base64,dGVzdA==",
		loadArtifact: async (id) => ({ id, kind: "image", runId: null, conversationId: null, createdAt: new Date(0), bytes: png, meta: { mime: "image/png" } }),
		saveDescription: async () => true,
		complete: async (params) => ({ message: { role: "assistant", content: "Uma flor" }, model: params.model, usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } }),
	});
	const result = await vision.describeUserImage("image-a");
	assert.equal(result.description, "Uma flor");
	assert.equal(result.costUsd, undefined);
	assert.equal(result.costUnknown, true);
});

test("descritor de manutenção não usa assinatura mesmo com modelo configurado ChatGPT",async()=>{
 let model:string|undefined;
 const vision=imageVisionForRun({userId:"a",apiKey:"fixture-key",fallbackModel:"chatgpt/luna",makeModelCopy:async()=>"data:image/png;base64,dGVzdA==",loadArtifact:async id=>({id,kind:"image",runId:null,conversationId:null,createdAt:new Date(0),bytes:png,meta:{mime:"image/png"}}),saveDescription:async()=>true,complete:async params=>{model=params.model;return {model:params.model,message:{role:"assistant",content:"A flower"}};}});
 await vision.describeUserImage("image-a");
 assert.equal(model,"openai/gpt-4o-mini");
});

test("visão: modelo de reserva Anthropic/OpenCode Go usa o adaptador da chave (não o OpenRouter)", async () => {
	const viaCalls: string[] = [];
	const vision = imageVisionForRun({
		userId: "u1",
		apiKey: "",
		fallbackModel: "anthropic-direct/claude-x",
		loadArtifact: (async () => ({ kind: "image", bytes: new Uint8Array([1, 2, 3]), meta: {} })) as never,
		saveDescription: (async () => undefined) as never,
		makeModelCopy: (async () => "data:image/png;base64,AAAA") as never,
		complete: (async () => {
			throw new Error("OpenRouter não deveria ser chamado");
		}) as never,
		streams: () => ({
			anthropic: (async (params: { model: string }) => {
				viaCalls.push(params.model);
				return { message: { role: "assistant", content: "um gato" }, model: params.model, usage: { costUsd: 0.001 } };
			}) as never,
			opencodeGo: (async () => ({})) as never,
		}),
	});
	const result = await vision.describeUserImage("a1");
	assert.equal(result.description, "um gato");
	assert.deepEqual(viaCalls, ["anthropic-direct/claude-x"]);
});

test("falha de leitura loga uma linha com id e motivo, sem caminho nem conteúdo", async () => {
	const lines: string[] = [];
	const vision = imageVisionForRun({
		userId: "user-a", apiKey: "test-key",
		logFailure: (line) => lines.push(line),
		loadArtifactDetailed: async () => ({ ok: false, reason: "read_failed:ENOENT" }),
	});
	assert.equal(await vision.loadUserImage("image-a"), null);
	assert.deepEqual(lines, ["[image-vision] imagem anexada indisponível artifact=image-a reason=read_failed errno=ENOENT attempt=1"]);
});

test("outro dono e artefato que não é imagem também são logados; sucesso não loga", async () => {
	const lines: string[] = [];
	const base = { runId: null, conversationId: null, createdAt: new Date(0), bytes: png, meta: { mime: "image/png" } };
	let next: Awaited<ReturnType<NonNullable<Parameters<typeof imageVisionForRun>[0]["loadArtifactDetailed"]>>> = { ok: false, reason: "not_found_for_owner" };
	const vision = imageVisionForRun({
		userId: "user-b", apiKey: "test-key",
		makeModelCopy: async () => "data:image/png;base64,dGVzdA==",
		logFailure: (line) => lines.push(line),
		loadArtifactDetailed: async () => next,
	});
	assert.equal(await vision.loadUserImage("image-a"), null);
	next = { ok: true, artifact: { ...base, id: "doc", kind: "file" } };
	assert.equal(await vision.loadUserImage("doc"), null);
	next = { ok: true, artifact: { ...base, id: "image-a", kind: "image" } };
	assert.match(await vision.loadUserImage("image-a") ?? "", /^data:image\//);
	assert.equal(lines.length, 2);
	assert.match(lines[0]!, /reason=not_found_for_owner/);
	assert.match(lines[1]!, /reason=not_an_image/);
	assert.ok(lines.every((line) => !line.includes("user-b")));
});

test("anexo do turno: falha transitória repete a leitura uma vez e marca attempt=2 no log", async () => {
	const lines: string[] = [];
	let calls = 0;
	const vision = imageVisionForRun({
		userId: "user-a", apiKey: "test-key", retryDelayMs: 0,
		makeModelCopy: async () => "data:image/png;base64,dGVzdA==",
		logFailure: (line) => lines.push(line),
		loadArtifactDetailed: async () => {
			calls++;
			return calls === 1 ? { ok: false, reason: "read_failed:ENOENT" } : { ok: true, artifact: { id: "image-a", kind: "image", runId: null, conversationId: null, createdAt: new Date(0), bytes: png, meta: { mime: "image/png" } } };
		},
	});
	assert.match(await vision.loadUserImage("image-a", { retryTransient: true }) ?? "", /^data:image\//);
	assert.equal(calls, 2);
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /attempt=1/);
	// Persistindo, o segundo log leva attempt=2.
	calls = -10;
	const failing = imageVisionForRun({ userId: "user-a", apiKey: "k", retryDelayMs: 0, logFailure: (line) => lines.push(line), loadArtifactDetailed: async () => ({ ok: false, reason: "read_failed:EIO" }) });
	assert.equal(await failing.loadUserImage("image-a", { retryTransient: true }), null);
	assert.deepEqual(lines.slice(1).map((line) => line.match(/attempt=\d/)?.[0]), ["attempt=1", "attempt=2"]);
});

test("sem retryTransient (histórico) ou com motivo permanente não repete a leitura", async () => {
	for (const [reason, retry] of [["read_failed:ENOENT", false], ["not_found_for_owner", true], ["empty_uri", true]] as const) {
		let calls = 0;
		const vision = imageVisionForRun({ userId: "user-a", apiKey: "k", retryDelayMs: 0, logFailure: () => undefined, loadArtifactDetailed: async () => { calls++; return { ok: false, reason }; } });
		assert.equal(await vision.loadUserImage("image-a", { retryTransient: retry }), null);
		assert.equal(calls, 1, `${reason} retry=${retry}`);
	}
});

test("describeUserImage sinaliza loadFailed quando a leitura falha (≠ sem modelo de apoio)", async () => {
	const failing = imageVisionForRun({ userId: "user-a", apiKey: "k", retryDelayMs: 0, logFailure: () => undefined, loadArtifactDetailed: async () => ({ ok: false, reason: "read_failed:ENOENT" }) });
	assert.deepEqual(await failing.describeUserImage("image-a", { retryTransient: true }), { description: null, loadFailed: true });
	const noHelper = imageVisionForRun({
		userId: "user-a", apiKey: "k",
		loadArtifact: async (id) => ({ id, kind: "image", runId: null, conversationId: null, createdAt: new Date(0), bytes: png, meta: { mime: "image/png" } }),
	});
	assert.deepEqual(await noHelper.describeUserImage("image-a"), { description: null });
});
