import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatgptProviderError } from "@workspace/llm";
import { createRunProviderServices, resetGoModelCooldowns } from "./provider-services.js";
test("catálogo desconhecido tenta visão e mantém contexto conservador por dono", async () => {
	const owners: string[] = [];
	const models = {
		isKnown: async (user: string) => {
			owners.push(user);
			return null;
		},
		find: async (user: string) => {
			owners.push(user);
			return undefined;
		},
	};
	const provider = createRunProviderServices({
		userId: "a",
		policy: null,
		onFallback: () => {},
		models,
		env: {},
	});
	assert.equal(await provider.isKnown("chatgpt/luna"), null);
	assert.equal(await provider.contextLength("chatgpt/luna"), 64000);
	assert.equal(await provider.supportsImageInput("chatgpt/luna"), true);
	assert.deepEqual(owners, ["a", "a", "a"]);
	assert.throws(() =>
		createRunProviderServices({
			userId: "default",
			policy: null,
			onFallback: () => {},
		})
	);
});
test("quota persiste só na conta B e aciona fallback sem credencial de A", async () => {
	const owners: string[] = [];
	const provider = createRunProviderServices({
		userId: "b",
		policy: null,
		onFallback: () => {},
		getConnection: async (user) => {
			owners.push("read:" + user);
			return null;
		},
		updateConnection: async (user) => {
			owners.push("write:" + user);
			return null;
		},
		chatgpt: async () => {
			throw new ChatgptProviderError(
				429,
				"subscription_sharing_usage_limit_exceeded"
			);
		},
		openrouter: async (params) => ({
			model: params.model,
			message: { role: "assistant", content: "done" },
		}),
	});
	const result = await provider.streamChat({
		apiKey: "",
		model: "chatgpt/luna",
		messages: [],
		tools: [],
	});
	assert.equal(result.model, "deepseek/deepseek-v4.1-flash");
	assert.deepEqual(owners, ["read:b", "write:b"]);
});

test("catálogo não transforma 404 de B ou flag desligada em modelo desconhecido", async () => {
	const denied = Object.assign(new Error("Not found"), { status: 404 });
	const models = {
		isKnown: async () => {
			throw denied;
		},
		find: async () => {
			throw denied;
		},
	};
	const provider = createRunProviderServices({
		userId: "b",
		policy: null,
		onFallback: () => {},
		models,
	});
	await assert.rejects(
		provider.isKnown("chatgpt/luna"),
		(error) => error === denied
	);
	await assert.rejects(
		provider.contextLength("chatgpt/luna"),
		(error) => error === denied
	);
	await assert.rejects(
		provider.supportsImageInput("chatgpt/luna"),
		(error) => error === denied
	);
});

test("visão explicitamente negada bloqueia; somente 503 permite catálogo desconhecido",async()=>{
 let missing=false;
 const model:import("@workspace/shared").ProviderModel={id:"chatgpt/luna",name:"Fixture",provider:"chatgpt",contextLength:12345,capabilities:{vision:false}};
 const models={isKnown:async()=>{if(missing)throw Object.assign(new Error("Unavailable"),{status:503});return true;},find:async()=>{if(missing)throw Object.assign(new Error("Unavailable"),{status:503});return model;}};
 const provider=createRunProviderServices({userId:"a",policy:null,onFallback:()=>{},models});
 assert.equal(await provider.supportsImageInput(model.id),false);
 assert.equal(await provider.contextLength(model.id),12345);
 missing=true;
 assert.equal(await provider.isKnown(model.id),null);
 assert.equal(await provider.supportsImageInput(model.id),true);
 assert.equal(await provider.contextLength(model.id),64000);
});

test("snapshot com o plano ChatGPT desligado bloqueia o run sem consultar a credencial", async () => {
	let liveCalls = 0;
	const auth = {
		getAccessToken: async () => {
			liveCalls++;
			return "token";
		},
		markNeedsLogin: async () => {},
	};
	const provider = createRunProviderServices({
		userId: "a",
		policy: null,
		chatgptEnabled: false,
		auth,
		onFallback: () => {},
		getConnection: async () => null,
	});
	await assert.rejects(
		provider.streamChat({ apiKey: "", model: "chatgpt/luna", messages: [], tools: [] }),
		(error) => error instanceof ChatgptProviderError
	);
	assert.equal(liveCalls, 0);
});

test("snapshot ligado ainda passa pela checagem ao vivo: desligar na UI vale na hora", async () => {
	let liveCalls = 0;
	const denied = Object.assign(new Error("not_found"), { status: 404 });
	const provider = createRunProviderServices({
		userId: "a",
		policy: null,
		chatgptEnabled: true,
		auth: {
			getAccessToken: async () => {
				liveCalls++;
				throw denied;
			},
			markNeedsLogin: async () => {},
		},
		onFallback: () => {},
		getConnection: async () => null,
	});
	await assert.rejects(
		provider.streamChat({ apiKey: "", model: "chatgpt/luna", messages: [], tools: [] }),
		(error) => error instanceof ChatgptProviderError
	);
	assert.equal(liveCalls, 1);
});

const base = { apiKey: "", tools: [], messages: [{ role: "user" as const, content: "oi" }] };
const KEY = "go-key-SEGREDO-0000";
const keyStatus = async () => ({ provider: "opencode-go" as const, status: "connected" as const, modelCount: 1, updatedAt: null, lastLimitAt: null, lastError: null });

test("modelos anthropic-direct/ e opencode-go/ vão ao adaptador da chave do dono", async () => {
	const seen: string[] = [];
	const provider = createRunProviderServices({
		userId: "u1",
		policy: null,
		onFallback: () => {},
		keys: { getKey: async () => KEY, status: keyStatus, markLimitAt: async () => {} },
		anthropic: async (p) => ({ model: p.model, message: { role: "assistant", content: (seen.push("anthropic"), "a") } }),
		opencodeGo: async (p) => ({ model: p.model, message: { role: "assistant", content: (seen.push("go"), "g") } }),
		openrouter: async (p) => ({ model: p.model, message: { role: "assistant", content: (seen.push("or"), "o") } }),
	});
	await provider.streamChat({ ...base, model: "anthropic-direct/claude-sonnet-5-5" });
	await provider.streamChat({ ...base, model: "opencode-go/kimi-k3" });
	await provider.streamChat({ ...base, model: "anthropic/claude-sonnet-5-5" });
	assert.deepEqual(seen, ["anthropic", "go", "or"]);
});

test("limite do OpenCode Go esfria só o modelo, cai no modelo padrão e avisa", async () => {
	resetGoModelCooldowns();
	const limits: string[] = [];
	const notices: string[] = [];
	const { ProviderApiError } = await import("@workspace/llm");
	let last: string | null = null;
	const provider = createRunProviderServices({
		userId: "u1",
		policy: null,
		onFallback: (n) => void notices.push(n.message),
		keys: {
			getKey: async () => KEY,
			status: async (...args) => ({ ...(await keyStatus()), lastLimitAt: last }),
			markLimitAt: async (user, p, at) => {
				limits.push(`${user}:${p}`);
				last = at.toISOString();
			},
		},
		opencodeGo: async () => {
			throw new ProviderApiError("opencode-go", 429, "limit_exceeded");
		},
		openrouter: async (p) => ({ model: p.model, message: { role: "assistant", content: "padrão" } }),
	});
	const result = await provider.streamChat({ ...base, model: "opencode-go/kimi-k3" });
	assert.equal(result.message.content, "padrão");
	assert.deepEqual(limits, ["u1:opencode-go"]);
	assert.deepEqual(notices, ["OpenCode Go indisponível para este modelo; usando deepseek-v4.1-flash"]);
	assert.ok(!JSON.stringify(notices).includes(KEY));
});

test("sem chave conectada o adaptador falha com erro de autenticação sem vazar nada", async () => {
	const provider = createRunProviderServices({
		userId: "u2",
		policy: null,
		onFallback: () => {},
		keys: { getKey: async () => null, status: keyStatus, markLimitAt: async () => {} },
	});
	await assert.rejects(provider.streamChat({ ...base, model: "anthropic-direct/claude-sonnet-5-5" }), (error: Error) => /Chave de API/.test(error.message));
});

test("catálogo de chaves alimenta isKnown/contexto/visão", async () => {
	const provider = createRunProviderServices({
		userId: "u1",
		policy: null,
		onFallback: () => {},
		keyModels: {
			isKnown: async (_u, _p, id) => id === "anthropic-direct/claude-sonnet-5-5",
			find: async (_u, p) => (p === "anthropic" ? { id: "x", name: "x", provider: "anthropic" as const, contextLength: 1_000_000, capabilities: { vision: true } } : undefined),
			protocolOf: async () => undefined,
		},
	});
	assert.equal(await provider.isKnown("anthropic-direct/claude-sonnet-5-5"), true);
	assert.equal(await provider.isKnown("anthropic-direct/nada"), false);
	assert.equal(await provider.contextLength("anthropic-direct/claude-sonnet-5-5"), 1_000_000);
	assert.equal(await provider.contextLength("opencode-go/kimi-k3"), 128_000);
	assert.equal(await provider.supportsImageInput("anthropic-direct/claude-sonnet-5-5"), true);
});

test("OpenCode Go indisponível sem OpenRouter nem padrão: erro claro, sem aviso e sem cooldown", async () => {
	resetGoModelCooldowns();
	const { ProviderApiError, NoFallbackModelError } = await import("@workspace/llm");
	const notices: string[] = [];
	let marked = 0;
	const provider = createRunProviderServices({
		userId: "u3",
		policy: null,
		openRouterKey: false,
		onFallback: (n) => void notices.push(n.message),
		keys: { getKey: async () => KEY, status: keyStatus, markLimitAt: async () => void (marked += 1) },
		opencodeGo: async () => {
			throw new ProviderApiError("opencode-go", 429, "unavailable");
		},
		openrouter: async () => {
			throw new Error("não deveria chamar");
		},
	});
	const error = await provider.streamChat({ ...base, model: "opencode-go/step-5-preview-free" }).catch((e: unknown) => e);
	assert.ok(error instanceof NoFallbackModelError);
	assert.equal((error as Error).message, "O OpenCode Go não respondeu e não há outro modelo disponível. Tente de novo ou escolha outro modelo.");
	assert.deepEqual(notices, []);
	assert.equal(marked, 0);
});

test("fallback sem chave do OpenRouter usa o modelo padrão da conta quando disponível", async () => {
	resetGoModelCooldowns();
	const { ProviderApiError } = await import("@workspace/llm");
	const used: string[] = [];
	const provider = createRunProviderServices({
		userId: "u4",
		policy: null,
		openRouterKey: false,
		accountDefaultModel: async () => "anthropic-direct/claude-sonnet-5-5",
		onFallback: () => {},
		keys: { getKey: async () => KEY, status: async (_u, p) => ({ ...(await keyStatus()), provider: p }), markLimitAt: async () => {} },
		opencodeGo: async () => {
			throw new ProviderApiError("opencode-go", 503, "unavailable");
		},
		anthropic: async (p) => ({ model: p.model, message: { role: "assistant", content: (used.push(p.model), "a") } }),
	});
	const result = await provider.streamChat({ ...base, model: "opencode-go/kimi-k3" });
	assert.equal(result.message.content, "a");
	assert.deepEqual(used, ["anthropic-direct/claude-sonnet-5-5"]);
});

test("limite de um modelo do Go não bloqueia outro modelo do mesmo provedor", async () => {
	resetGoModelCooldowns();
	const { ProviderApiError } = await import("@workspace/llm");
	const calls: string[] = [];
	const provider = createRunProviderServices({
		userId: "u5",
		policy: null,
		openRouterKey: true,
		onFallback: () => {},
		keys: { getKey: async () => KEY, status: keyStatus, markLimitAt: async () => {} },
		opencodeGo: async (p) => {
			calls.push(p.model);
			if (p.model.endsWith("kimi-k3")) throw new ProviderApiError("opencode-go", 429, "limit_exceeded");
			return { model: p.model, message: { role: "assistant", content: "go" } };
		},
		openrouter: async (p) => ({ model: p.model, message: { role: "assistant", content: "or" } }),
	});
	await provider.streamChat({ ...base, model: "opencode-go/kimi-k3" });
	await provider.streamChat({ ...base, model: "opencode-go/kimi-k3" });
	const other = await provider.streamChat({ ...base, model: "opencode-go/glm-5.3" });
	assert.equal(other.message.content, "go");
	assert.deepEqual(calls, ["opencode-go/kimi-k3", "opencode-go/glm-5.3"]);
});

test("OpenCode Go sem visão declarada não recebe imagem (a reserva de visão descreve); com visão declarada recebe", async () => {
	const make = (capabilities: "unknown" | { vision?: boolean }) =>
		createRunProviderServices({
			userId: "u1",
			policy: null,
			onFallback: () => {},
			keyModels: {
				isKnown: async () => true,
				find: async () => ({ id: "x", name: "x", provider: "opencode-go" as const, contextLength: 1000, capabilities }),
				protocolOf: async () => undefined,
			},
		});
	assert.equal(await make("unknown").supportsImageInput("opencode-go/glm-5.3"), false);
	assert.equal(await make({ vision: false }).supportsImageInput("opencode-go/glm-5.3"), false);
	assert.equal(await make({ vision: true }).supportsImageInput("opencode-go/kimi-k3"), true);
});
