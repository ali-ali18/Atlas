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
	assert.deepEqual(await vision.describeUserImage("image-a"), { description: null });
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
