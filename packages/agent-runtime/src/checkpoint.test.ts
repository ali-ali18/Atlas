import { describe, expect, it } from "vitest";
import type { LlmMessage } from "@workspace/llm";
import { AGENT_RUNTIME_CHECKPOINT_VERSION } from "@workspace/shared";
import {
	artifactRefUrl,
	buildRuntimeCheckpoint,
	hydrateLlmMessages,
	parseRuntimeCheckpoint,
	resolveLlmMessagesForModel,
	serializeLlmMessages,
	toolIdempotencyKey,
} from "./checkpoint.js";

import { perToolFailureStreak } from "./tool-failure.js";
import type { ToolOutcome } from "./progress.js";

function fail(name: string, step: number): ToolOutcome {
	return { name, argsKey: `${name}:${step}`, resultKey: "err:x", ok: false, step, kind: "other" };
}

describe("checkpoint serialization", () => {
	it("carrega o contador de recuperações e lê checkpoint antigo como 0", () => {
		const base = { messages: [], conversation: [], nextStepIndex: 1, model: "m" };
		const carried = buildRuntimeCheckpoint({ ...base, recoveries: 2 });
		expect(parseRuntimeCheckpoint(JSON.parse(JSON.stringify(carried)))?.recoveries).toBe(2);
		expect(buildRuntimeCheckpoint(base)).not.toHaveProperty("recoveries");
		const withStep = buildRuntimeCheckpoint({ ...base, recoveries: 1, recoveredAtStep: 7 });
		expect(parseRuntimeCheckpoint(JSON.parse(JSON.stringify(withStep)))?.recoveredAtStep).toBe(7);
		expect(parseRuntimeCheckpoint({ messages: [], recoveries: 2 })).not.toHaveProperty("recoveredAtStep");
		for (const recoveries of [undefined, -1, "2", Number.NaN]) {
			expect(parseRuntimeCheckpoint({ messages: [], recoveries })).not.toHaveProperty("recoveries");
		}
	});

	it("preserva limite de imagens mostradas e aceita checkpoints antigos", () => {
		const checkpoint = buildRuntimeCheckpoint({ messages: [], conversation: [], nextStepIndex: 1, model: "m", shownImageCount: 6 });
		expect(parseRuntimeCheckpoint(JSON.parse(JSON.stringify(checkpoint)))?.shownImageCount).toBe(6);
		for (const shownImageCount of [undefined, -1, 1.5, "6", Infinity]) {
			expect(parseRuntimeCheckpoint({ messages: [], shownImageCount })?.shownImageCount).toBe(0);
		}
	});
	it("pedidos para depois (triagem) sobrevivem ao resume; lixo é descartado", () => {
		const checkpoint = buildRuntimeCheckpoint({ messages: [], conversation: [], nextStepIndex: 1, model: "m", pendingFollowUps: ["Send a summary."] });
		expect(parseRuntimeCheckpoint(JSON.parse(JSON.stringify(checkpoint)))?.pendingFollowUps).toEqual(["Send a summary."]);
		expect(parseRuntimeCheckpoint({ messages: [], pendingFollowUps: ["ok", 3, "  ", null] })?.pendingFollowUps).toEqual(["ok"]);
		expect(parseRuntimeCheckpoint({ messages: [] })?.pendingFollowUps).toBeUndefined();
	});
	it("degrada Data URL em vez de matar o run", () => {
		const conversation: LlmMessage[] = [
			{
				role: "user",
				content: [
					{
						type: "image_url",
						image_url: { url: "data:image/png;base64,aaaa" },
					},
				],
			},
		];
		expect(serializeLlmMessages(conversation)[0]?.content).toEqual([
			{ type: "text", text: "[screenshot omitido do checkpoint]" },
		]);
	});

	it("canônica guarda ref; transporte expande para o modelo", async () => {
		const conversation: LlmMessage[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Screenshot atual da tela:" },
					{
						type: "image_url",
						image_url: { url: artifactRefUrl("art_1") },
					},
				],
			},
		];
		const serialized = serializeLlmMessages(conversation);
		expect(serialized[0]?.content).toEqual([
			{ type: "text", text: "Screenshot atual da tela:" },
			{ type: "screenshot_ref", artifactId: "art_1" },
		]);

		const hydrated = await hydrateLlmMessages(serialized);
		// Hidratar NÃO expande: canônica mantém ref (nunca Data URL).
		expect(hydrated[0]?.content).toEqual([
			{ type: "text", text: "Screenshot atual da tela:" },
			{ type: "screenshot_ref", artifactId: "art_1" },
		]);
		// Round-trip: serializar de novo não explode.
		expect(() => serializeLlmMessages(hydrated)).not.toThrow();

		const transport = await resolveLlmMessagesForModel(
			hydrated,
			async (id) => (id === "art_1" ? "data:image/png;base64,abc" : null),
		);
		expect(transport[0]?.content).toEqual([
			{ type: "text", text: "Screenshot atual da tela:" },
			{
				type: "image_url",
				image_url: { url: "data:image/png;base64,abc" },
			},
		]);
		// Canônica intacta após resolver.
		expect(hydrated[0]?.content).toEqual([
			{ type: "text", text: "Screenshot atual da tela:" },
			{ type: "screenshot_ref", artifactId: "art_1" },
		]);
	});

	it("checkpoint antigo com skillPins ainda carrega e o campo some do novo", () => {
		const old = {
			version: 2,
			messages: [{ role: "user", content: "oi" }],
			llmMessages: [{ role: "assistant", content: "x" }],
			nextStepIndex: 4,
			model: "m",
			skillPins: [{ skillId: "s", versionId: "v" }],
		};
		const parsed = parseRuntimeCheckpoint(JSON.parse(JSON.stringify(old)));
		expect(parsed?.nextStepIndex).toBe(4);
		expect(parsed?.messages).toHaveLength(1);
		expect(parsed && "skillPins" in parsed).toBe(false);
		const rebuilt = buildRuntimeCheckpoint({ messages: [], conversation: [], nextStepIndex: 1, model: "m" });
		expect("skillPins" in rebuilt).toBe(false);
	});
	it("grava nextStepIndex e versão", () => {
		const checkpoint = buildRuntimeCheckpoint({
			messages: [{ role: "user", content: "oi" }],
			conversation: [{ role: "system", content: "sys" }],
			nextStepIndex: 3,
			model: "test-model",
		});
		expect(checkpoint.version).toBe(AGENT_RUNTIME_CHECKPOINT_VERSION);
		expect(checkpoint.nextStepIndex).toBe(3);
		expect(checkpoint.model).toBe("test-model");
	});

	it("deriva chave estável de ferramenta", () => {
		expect(
			toolIdempotencyKey({
				runId: "r1",
				decisionIndex: 2,
				toolCallId: "call_9",
				toolName: "navigate",
			}),
		).toBe("r1:2:call_9:navigate");
	});
});

describe("F12/B5 - checkpoint do pedido de login", () => {
	it("loginAsked e pendingLogin sobrevivem ao build/parse; lixo é descartado", () => {
		const checkpoint = buildRuntimeCheckpoint({
			messages: [],
			conversation: [],
			nextStepIndex: 3,
			model: "m",
			loginAsked: ["https://a.com/login"],
			pendingLogin: { loginId: "login-1", site: "a.com", url: "https://a.com/login" },
		});
		const parsed = parseRuntimeCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
		expect(parsed?.loginAsked).toEqual(["https://a.com/login"]);
		expect(parsed?.pendingLogin).toEqual({ loginId: "login-1", site: "a.com", url: "https://a.com/login" });
		const dirty = parseRuntimeCheckpoint({ messages: [], loginAsked: [1, "x"], pendingLogin: { loginId: 3 } });
		expect(dirty?.loginAsked).toEqual(["x"]);
		expect(dirty?.pendingLogin).toBeUndefined();
	});
});

describe("checkpoint: triagedInputs", () => {
	it("sobrevive ao ciclo build -> JSON -> parse e descarta lixo", () => {
		const triagedInputs = [{ ids: ["i1"], text: "oi", verdict: { kind: "later" as const, cancel: false, reply: "Faço depois.", instruction: "Tabela" } }];
		const checkpoint = buildRuntimeCheckpoint({ messages: [], conversation: [], nextStepIndex: 1, model: "m", triagedInputs });
		expect(parseRuntimeCheckpoint(JSON.parse(JSON.stringify(checkpoint)))?.triagedInputs).toEqual(triagedInputs);
		expect(parseRuntimeCheckpoint({ messages: [], triagedInputs: [{ ids: [], text: "x" }, "lixo", { ids: ["a"], text: "b", verdict: { kind: "x" } }] })?.triagedInputs).toBeUndefined();
	});
});

describe("checkpoint: ferramentas congeladas na conversa", () => {
	it("grava e lê o estado do cache de prompt; malformado é ignorado", () => {
		const toolCache = { turn: 2, at: "2026-10-23T12:00:00.000Z", segments: [["routines"], ["files"]], lastUsed: { routines: 1, files: 2 }, toolOrder: ["memory", "propose_routine", "create_file"] };
		const checkpoint = buildRuntimeCheckpoint({ messages: [], conversation: [], nextStepIndex: 1, model: "m", toolCache });
		expect(parseRuntimeCheckpoint(JSON.parse(JSON.stringify(checkpoint)))?.toolCache).toEqual(toolCache);
		expect(parseRuntimeCheckpoint({ messages: [], toolCache: { turn: "x" } })?.toolCache).toBeUndefined();
	});
});

describe("checkpoint: bloqueio de tool com validade", () => {
	it("blockedToolSteps sobrevive ao ciclo build -> JSON -> parse e descarta lixo", () => {
		const checkpoint = buildRuntimeCheckpoint({ messages: [], conversation: [], nextStepIndex: 5, model: "m", blockedTools: { web_extract: "boom" }, blockedToolSteps: { web_extract: 4 } });
		const parsed = parseRuntimeCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
		expect(parsed?.blockedTools).toEqual({ web_extract: "boom" });
		expect(parsed?.blockedToolSteps).toEqual({ web_extract: 4 });
		expect(parseRuntimeCheckpoint({ messages: [], blockedToolSteps: { a: "x", b: Infinity, c: -2.5 } })?.blockedToolSteps).toEqual({ c: 0 });
	});
	it("unblockedAtStep sobrevive ao resume (a contagem de falhas não volta a incluir o que veio antes da expiração)", () => {
		const checkpoint = buildRuntimeCheckpoint({ messages: [], conversation: [], nextStepIndex: 9, model: "m", unblockedAtStep: { web_extract: 7 } });
		const parsed = parseRuntimeCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
		expect(parsed?.unblockedAtStep).toEqual({ web_extract: 7 });
		// Com o marcador restaurado, as 3 falhas antigas não contam e uma falha nova vale 1 (não re-bloqueia).
		const outcomes = [fail("web_extract", 1), fail("web_extract", 2), fail("web_extract", 3), fail("web_extract", 9)];
		expect(perToolFailureStreak(outcomes, "web_extract", parsed?.unblockedAtStep?.web_extract)).toBe(1);
		expect(perToolFailureStreak(outcomes, "web_extract", undefined)).toBe(4);
		expect(buildRuntimeCheckpoint({ messages: [], conversation: [], nextStepIndex: 1, model: "m" }).unblockedAtStep).toBeUndefined();
		expect(parseRuntimeCheckpoint({ messages: [] })?.unblockedAtStep).toBeUndefined();
	});
	it("checkpoint antigo (só blockedTools) ainda carrega, sem passos", () => {
		const parsed = parseRuntimeCheckpoint({ messages: [], blockedTools: { web_extract: "boom" } });
		expect(parsed?.blockedTools).toEqual({ web_extract: "boom" });
		expect(parsed?.blockedToolSteps).toBeUndefined();
	});
});
