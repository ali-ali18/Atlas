import { describe, expect, it } from "vitest";
import {
	DEFAULT_LLM_TIMEOUTS,
	parseRunConfigSnapshot,
	resolveEffectiveConfig,
	toRunConfigSnapshot,
} from "./effective-config.js";

const resolve = (config: unknown, env: Record<string, string | undefined> = {}, sandboxAutoStart?: boolean | null) =>
	resolveEffectiveConfig({ user: { config, sandboxAutoStart }, env });

describe("sem configuração do usuário = valores de hoje", () => {
	it("env vazio: tudo no padrão do código", () => {
		const e = resolve(undefined);
		expect(e.providers.chatgptEnabled).toEqual({ value: false, source: "default" });
		expect(e.models.default).toEqual({ value: "openai/gpt-4o-mini", source: "default" });
		expect(e.models.fallbacks).toEqual({ value: [], source: "default" });
		expect(e.models.maintenance).toEqual({ value: "openai/gpt-6-luna", source: "default" });
		expect(e.models.summary).toEqual({ value: "openai/gpt-6-luna", source: "default" });
		expect(e.models.vision).toEqual({ value: undefined, source: "default" });
		expect(e.models.image).toEqual({ value: undefined, source: "default" });
		expect(e.jev.mcp).toEqual({ value: "off", source: "default" });
		for (const feature of Object.values(e.jev.features)) expect(feature).toEqual({ value: "off", source: "default" });
		expect(e.execution.discipline).toEqual({ value: true, source: "default" });
		expect(e.execution.contextEconomy).toEqual({ value: true, source: "default" });
		expect(e.execution.contextMemory).toEqual({ value: "standard", source: "default" });
		expect(e.execution.llmTimeouts).toEqual({ value: DEFAULT_LLM_TIMEOUTS, source: "default" });
		expect(e.execution.maxOutputTokens).toEqual({ value: undefined, source: "default" });
		expect(e.execution.maxSteps.value).toBeUndefined();
		expect(e.execution.maxWallMinutes.value).toBeUndefined();
		expect(e.execution.maxRunCostUsd).toEqual({ value: undefined, source: "default" });
		expect(e.sandboxAutoStart).toEqual({ value: true, source: "default" });
		// Bot novo nasce em "auto" (segue o idioma de quem escreve); quem fixou um idioma na conta mantém o dele.
		expect(e.general.defaultBotLanguage).toEqual({ value: "auto", source: "default" });
		expect(e.general.timezone).toEqual({ value: undefined, source: "default" });
	});

	it("env do servidor vira o valor, com origem env", () => {
		const e = resolve(undefined, {
			ATLAS_PROVIDER_CHATGPT_ENABLED: "true",
			OPENROUTER_MODEL: " a/model ",
			OPENROUTER_FALLBACK_MODELS: "x/y, ,z/w",
			ATLAS_MAINTENANCE_MODEL: "m/maint",
			SUMMARIZER_MODEL: "m/sum",
			ATLAS_VISION_FALLBACK_MODEL: "v/see",
			ATLAS_IMAGE_MODEL: "i/gen",
			JEV_MCP_MODE: "gate",
			JEV_INTENT_MODE: "ON",
			JEV_STUCK_MODE: "shadow",
			ATLAS_EXECUTION_DISCIPLINE: "off",
			ATLAS_CONTEXT_ECONOMY: "off",
			LLM_DECISION_TIMEOUT_MS: "60000",
			LLM_IDLE_TIMEOUT_MS: "5000",
			LLM_MAX_OUTPUT_TOKENS: "6000",
		});
		expect(e.providers.chatgptEnabled).toEqual({ value: true, source: "env" });
		expect(e.models.default).toEqual({ value: "a/model", source: "env" });
		expect(e.models.fallbacks).toEqual({ value: ["x/y", "z/w"], source: "env" });
		expect(e.models.maintenance).toEqual({ value: "m/maint", source: "env" });
		expect(e.models.summary).toEqual({ value: "m/sum", source: "env" });
		expect(e.models.vision).toEqual({ value: "v/see", source: "env" });
		expect(e.models.image).toEqual({ value: "i/gen", source: "env" });
		expect(e.jev.mcp).toEqual({ value: "gate", source: "env" });
		expect(e.jev.features.intent).toEqual({ value: "on", source: "env" });
		expect(e.jev.features.stuck).toEqual({ value: "shadow", source: "env" });
		expect(e.jev.features.tools.source).toBe("default");
		expect(e.execution.discipline).toEqual({ value: false, source: "env" });
		expect(e.execution.contextEconomy).toEqual({ value: false, source: "env" });
		expect(e.execution.llmTimeouts).toEqual({
			value: { totalMs: 60000, firstEventMs: 30000, idleMs: 5000 },
			source: "env",
		});
		expect(e.execution.maxOutputTokens).toEqual({ value: 6000, source: "env" });
	});

	it("env inválido é ignorado e cai no padrão", () => {
		const e = resolve(undefined, {
			ATLAS_PROVIDER_CHATGPT_ENABLED: "maybe",
			JEV_MCP_MODE: "on",
			JEV_TOOLS_MODE: "gate",
			ATLAS_EXECUTION_DISCIPLINE: "banana",
			LLM_DECISION_TIMEOUT_MS: "abc",
			LLM_FIRST_EVENT_TIMEOUT_MS: "-5",
			LLM_IDLE_TIMEOUT_MS: "9999999999",
			LLM_MAX_OUTPUT_TOKENS: "1.5",
		});
		expect(e.providers.chatgptEnabled).toEqual({ value: false, source: "default" });
		expect(e.jev.mcp).toEqual({ value: "off", source: "default" });
		expect(e.jev.features.tools).toEqual({ value: "off", source: "default" });
		expect(e.execution.discipline).toEqual({ value: true, source: "default" });
		expect(e.execution.llmTimeouts).toEqual({ value: DEFAULT_LLM_TIMEOUTS, source: "default" });
		expect(e.execution.maxOutputTokens.source).toBe("default");
	});

	it("manutenção nunca é chatgpt/* vinda do env", () => {
		const e = resolve(undefined, { ATLAS_MAINTENANCE_MODEL: "chatgpt/gpt-5" });
		expect(e.models.maintenance).toEqual({ value: "openai/gpt-6-luna", source: "default" });
		const v = resolve(undefined, { ATLAS_VISION_FALLBACK_MODEL: "chatgpt/gpt-5" });
		expect(v.models.vision.value).toBe("openai/gpt-4o-mini");
	});

	it("resumo ignora ATLAS_MAINTENANCE_MODEL; revisão de memória usa a cadeia de 4", () => {
		const e = resolve(undefined, { ATLAS_MAINTENANCE_MODEL: "m/maint", SUMMARIZER_MODEL: "m/sum" });
		expect(e.models.summary.value).toBe("m/sum");
		expect(e.models.maintenance.value).toBe("m/maint");
		const only = resolve(undefined, { SUMMARIZER_MODEL: "m/sum" });
		expect(only.models.maintenance).toEqual({ value: "m/sum", source: "env" });
	});
});

describe("usuário > env > padrão", () => {
	const env = {
		ATLAS_PROVIDER_CHATGPT_ENABLED: "false",
		OPENROUTER_MODEL: "env/model",
		ATLAS_MAINTENANCE_MODEL: "env/maint",
		JEV_INTENT_MODE: "on",
		JEV_TOOLS_MODE: "shadow",
		ATLAS_EXECUTION_DISCIPLINE: "on",
		LLM_DECISION_TIMEOUT_MS: "1000",
		LLM_MAX_OUTPUT_TOKENS: "6000",
	};

	it("o dono liga o ChatGPT mesmo com env false", () => {
		expect(resolve({ v: 1, providers: { chatgptEnabled: true } }, env).providers.chatgptEnabled).toEqual({
			value: true,
			source: "user",
		});
		expect(
			resolve({ v: 1, providers: { chatgptEnabled: false } }, { ATLAS_PROVIDER_CHATGPT_ENABLED: "true" }).providers
				.chatgptEnabled,
		).toEqual({ value: false, source: "user" });
	});

	it("modelos", () => {
		const e = resolve(
			{ v: 1, models: { default: "u/model", fallbacks: ["u/a"], maintenance: "u/maint", vision: "u/see", image: "u/gen" } },
			env,
		);
		expect(e.models.default).toEqual({ value: "u/model", source: "user" });
		expect(e.models.fallbacks).toEqual({ value: ["u/a"], source: "user" });
		expect(e.models.maintenance).toEqual({ value: "u/maint", source: "user" });
		expect(e.models.summary).toEqual({ value: "u/maint", source: "user" });
		expect(e.models.vision).toEqual({ value: "u/see", source: "user" });
		expect(e.models.image).toEqual({ value: "u/gen", source: "user" });
	});

	it("modelo de ditado: usuário > ATLAS_STT_MODEL > padrão do provedor (undefined)", () => {
		expect(resolve({ v: 1, models: { stt: "u/stt" } }, { ATLAS_STT_MODEL: "e/stt" }).models.stt).toEqual({ value: "u/stt", source: "user" });
		expect(resolve({ v: 1 }, { ATLAS_STT_MODEL: " e/stt " }).models.stt).toEqual({ value: "e/stt", source: "env" });
		expect(resolve({ v: 1 }, {}).models.stt).toEqual({ value: undefined, source: "default" });
		// configJson antigo (sem stt) continua válido
		expect(resolve({ v: 1, models: { default: "a/b" } }, {}).models.stt.source).toBe("default");
	});

	it("Jev: recurso do usuário > geral do usuário > env do recurso > off", () => {
		const e = resolve({ v: 1, jev: { all: "shadow", features: { intent: "off" }, mcp: "shadow" } }, env);
		expect(e.jev.features.intent).toEqual({ value: "off", source: "user" });
		expect(e.jev.features.tools).toEqual({ value: "shadow", source: "user" });
		expect(e.jev.features.verify).toEqual({ value: "shadow", source: "user" });
		expect(e.jev.mcp).toEqual({ value: "shadow", source: "user" });
		const noAll = resolve({ v: 1, jev: { features: { verify: "on" } } }, env);
		expect(noAll.jev.features.verify).toEqual({ value: "on", source: "user" });
		expect(noAll.jev.features.intent).toEqual({ value: "on", source: "env" });
		expect(noAll.jev.features.tools).toEqual({ value: "shadow", source: "env" });
		expect(noAll.jev.features.stuck).toEqual({ value: "off", source: "default" });
	});

	it("execução", () => {
		const e = resolve(
			{
				v: 1,
				execution: { discipline: false, llmTimeoutPreset: "extended", maxOutputTokens: 16384, maxSteps: 300, maxWallMinutes: 10, maxRunCostUsd: 0.50 },
			},
			env,
		);
		expect(e.execution.discipline).toEqual({ value: false, source: "user" });
		expect(e.execution.llmTimeouts).toEqual({
			value: { totalMs: 180000, firstEventMs: 60000, idleMs: 40000 },
			source: "user",
		});
		expect(e.execution.maxOutputTokens).toEqual({ value: 16384, source: "user" });
		expect(e.execution.maxSteps).toEqual({ value: 300, source: "user" });
		expect(e.execution.maxWallMinutes).toEqual({ value: 10, source: "user" });
		expect(e.execution.maxRunCostUsd).toEqual({ value: 0.50, source: "user" });
		const short = resolve({ v: 1, execution: { llmTimeoutPreset: "short" } });
		expect(short.execution.llmTimeouts.value).toEqual({ totalMs: 45000, firstEventMs: 15000, idleMs: 10000 });
	});

	it("economia de contexto: usuário > env > padrão ligado", () => {
		expect(resolve(undefined, {}).execution.contextEconomy).toEqual({ value: true, source: "default" });
		expect(resolve(undefined, { ATLAS_CONTEXT_ECONOMY: "0" }).execution.contextEconomy).toEqual({ value: false, source: "env" });
		expect(resolve(undefined, { ATLAS_CONTEXT_ECONOMY: "banana" }).execution.contextEconomy).toEqual({ value: true, source: "default" });
		// O dono liga mesmo com o servidor desligado, e desliga mesmo com o servidor ligado.
		expect(resolve({ v: 1, execution: { contextEconomy: true } }, { ATLAS_CONTEXT_ECONOMY: "off" }).execution.contextEconomy).toEqual({ value: true, source: "user" });
		expect(resolve({ v: 1, execution: { contextEconomy: false } }, { ATLAS_CONTEXT_ECONOMY: "on" }).execution.contextEconomy).toEqual({ value: false, source: "user" });
	});

	it("custo máximo: usuário > env > sem limite de fábrica", () => {
		expect(resolve(undefined, {}).execution.maxRunCostUsd).toEqual({ value: undefined, source: "default" });
		expect(resolve(undefined, { ATLAS_MAX_RUN_COST_USD: "0.50" }).execution.maxRunCostUsd).toEqual({ value: 0.50, source: "env" });
		expect(resolve(undefined, { ATLAS_MAX_RUN_COST_USD: "banana" }).execution.maxRunCostUsd).toEqual({ value: undefined, source: "default" });
		expect(resolve({ v: 1, execution: { maxRunCostUsd: 1.00 } }, { ATLAS_MAX_RUN_COST_USD: "0.25" }).execution.maxRunCostUsd).toEqual({ value: 1.00, source: "user" });
	});

	it("sandboxAutoStart vem da coluna; ausente = padrão", () => {
		expect(resolve(undefined, {}, false).sandboxAutoStart).toEqual({ value: false, source: "user" });
		expect(resolve(undefined, {}, null).sandboxAutoStart).toEqual({ value: true, source: "default" });
	});

	it("valor inválido no config do usuário é ignorado (herda)", () => {
		const e = resolve({ v: 1, models: { default: "bad id" }, jev: { mcp: "on" }, execution: { maxSteps: 501 } }, env);
		expect(e.models.default).toEqual({ value: "env/model", source: "env" });
		expect(e.jev.mcp.source).toBe("default");
		expect(e.execution.maxSteps.value).toBeUndefined();
	});

	it("config de versão futura é ignorada por inteiro", () => {
		expect(resolve({ v: 2, models: { default: "u/model" } }, env).models.default.source).toBe("env");
	});
});

describe("memória da conversa", () => {
	it("Padrão para todos (inclusive config antiga sem o campo); a escolha do usuário vence", () => {
		expect(resolve({ v: 1, execution: { maxSteps: 100 } }).execution.contextMemory).toEqual({ value: "standard", source: "default" });
		expect(resolve({ v: 1, execution: { contextMemory: "economy" } }).execution.contextMemory).toEqual({ value: "economy", source: "user" });
	});
	it("vai no snapshot do run; snapshot antigo sem o campo segue válido; valor inválido é recusado", () => {
		const snap = toRunConfigSnapshot(resolve({ v: 1, execution: { contextMemory: "economy" } }));
		expect(snap.contextMemory).toBe("economy");
		expect(parseRunConfigSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
		const { contextMemory: _omit, ...legacy } = snap;
		expect(parseRunConfigSnapshot(legacy)).toEqual(legacy);
		expect(parseRunConfigSnapshot({ ...snap, contextMemory: "x" })).toBeNull();
	});
});

describe("tamanho máximo do resultado de ferramentas", () => {
	it("usuário > env > nenhum, e vai para o snapshot e de volta", () => {
		expect(resolve({ v: 1 }).execution.toolResultMaxChars).toEqual({ value: undefined, source: "default" });
		expect(resolve({ v: 1 }, { ATLAS_TOOL_RESULT_MAX_CHARS: "50000" }).execution.toolResultMaxChars).toEqual({ value: 50_000, source: "env" });
		const e = resolve({ v: 1, execution: { toolResultMaxChars: 100_000 } }, { ATLAS_TOOL_RESULT_MAX_CHARS: "50000" });
		expect(e.execution.toolResultMaxChars).toEqual({ value: 100_000, source: "user" });
		const snap = toRunConfigSnapshot(e);
		expect(snap.toolResultMaxChars).toBe(100_000);
		expect(parseRunConfigSnapshot(snap)).toEqual(snap);
		expect(parseRunConfigSnapshot({ ...snap, toolResultMaxChars: -1 })).toBeNull();
		expect(toRunConfigSnapshot(resolve({ v: 1 }))).not.toHaveProperty("toolResultMaxChars");
	});
});

describe("snapshot do run", () => {
	const resolveSnapshot = (contextEconomy: boolean) =>
		toRunConfigSnapshot(resolve({ v: 1, execution: { contextEconomy } }));

	it("round-trip e valores planos", () => {
		const e = resolve({ v: 1, models: { image: "i/g" }, execution: { maxSteps: 100 } }, { LLM_MAX_OUTPUT_TOKENS: "4096" });
		const snap = toRunConfigSnapshot(e);
		expect(snap).toMatchObject({ v: 1, imageModel: "i/g", maxSteps: 100, maxOutputTokens: 4096, executionDiscipline: true });
		expect(snap.contextEconomy).toBe(true);
		expect(resolveSnapshot(false)).toMatchObject({ contextEconomy: false });
		// Snapshot de antes da chave existir continua válido (o runtime cai no env).
		const { contextEconomy: _omit, ...legacy } = snap;
		expect(parseRunConfigSnapshot(legacy)).toEqual(legacy);
		expect(parseRunConfigSnapshot({ ...snap, contextEconomy: "on" })).toBeNull();
		expect(snap).not.toHaveProperty("visionModel");
		expect(parseRunConfigSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
	});
	it("snapshot inconsistente vira null", () => {
		const snap = toRunConfigSnapshot(resolve(undefined));
		expect(parseRunConfigSnapshot(null)).toBeNull();
		expect(parseRunConfigSnapshot({ ...snap, v: 2 })).toBeNull();
		expect(parseRunConfigSnapshot({ ...snap, jevMcpMode: "on" })).toBeNull();
		expect(parseRunConfigSnapshot({ ...snap, llmTimeouts: { totalMs: 0 } })).toBeNull();
		expect(parseRunConfigSnapshot({ ...snap, jevModes: { intent: "off" } })).toBeNull();
		expect(parseRunConfigSnapshot({ ...snap, maxSteps: "7" })).toBeNull();
	});
});

describe("grupos: coordenação inteligente (Jev)", () => {
	it("desligada por padrão; usuário > env > padrão", () => {
		expect(resolve(undefined).groups.jevCoordination).toEqual({ value: false, source: "default" });
		expect(resolve(undefined, { GROUPS_JEV_COORDINATION: "on" }).groups.jevCoordination).toEqual({ value: true, source: "env" });
		expect(resolve({ v: 1, groups: { jevCoordination: false } }, { GROUPS_JEV_COORDINATION: "on" }).groups.jevCoordination).toEqual({ value: false, source: "user" });
		expect(resolve({ v: 1, groups: { jevCoordination: true } }).groups.jevCoordination).toEqual({ value: true, source: "user" });
	});
});
