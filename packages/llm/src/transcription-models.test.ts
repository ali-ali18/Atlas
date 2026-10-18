import { describe, expect, it } from "vitest";
import {
	OPENAI_STT_MODELS,
	applyUserSttModel,
	fetchOpenRouterTranscriptionModels,
	parseTranscriptionModel,
	pricePerMinute,
} from "./transcription-models.js";

const OR = { apiKey: "k", baseUrl: "https://openrouter.ai/api/v1", model: "openai/whisper-large-v3", provider: "openrouter" as const };
const OA = { apiKey: "k", baseUrl: "https://x/v1", model: "gpt-4o-mini-transcribe", provider: "openai" as const };

describe("pricePerMinute", () => {
	it("converte US$/s em US$/min", () => {
		expect(pricePerMinute("0.0000075")).toBe(0.00045);
		expect(pricePerMinute(0.00003055555555555)).toBeCloseTo(0.001833, 6);
	});
	it("ausente, zero ou inválido = null", () => {
		for (const v of [undefined, "0", "abc", -1, null, {}]) expect(pricePerMinute(v)).toBeNull();
	});
});

describe("parseTranscriptionModel", () => {
	it("lê id, nome, vendor e preço", () => {
		expect(parseTranscriptionModel({ id: "openai/whisper-large-v3", name: "OpenAI: Whisper Large V3", pricing: { prompt: "0.0000075" } })).toEqual({
			id: "openai/whisper-large-v3",
			name: "OpenAI: Whisper Large V3",
			vendor: "openai",
			pricePerMinuteUsd: 0.00045,
		});
	});
	it("descarta item malformado e alias com ~", () => {
		expect(parseTranscriptionModel(null)).toBeNull();
		expect(parseTranscriptionModel({ id: "  " })).toBeNull();
		expect(parseTranscriptionModel({ id: "~x/y" })).toBeNull();
		expect(parseTranscriptionModel({ id: "a/b" })?.pricePerMinuteUsd).toBeNull();
	});
});

describe("fetchOpenRouterTranscriptionModels", () => {
	it("pede output_modalities=transcription e ignora lixo", async () => {
		let url = "";
		const fetchFn = (async (u: string) => {
			url = u;
			return Response.json({ data: [{ id: "a/b", name: "B", pricing: { prompt: "0.00001" } }, 5] });
		}) as unknown as typeof fetch;
		const models = await fetchOpenRouterTranscriptionModels(fetchFn);
		expect(url).toBe("https://openrouter.ai/api/v1/models?output_modalities=transcription");
		expect(models.map((m) => m.id)).toEqual(["a/b"]);
	});
	it("status de erro lança", async () => {
		await expect(fetchOpenRouterTranscriptionModels((async () => new Response("", { status: 500 })) as unknown as typeof fetch)).rejects.toThrow("500");
	});
});

describe("applyUserSttModel", () => {
	it("sem escolha mantém a config do servidor", () => {
		expect(applyUserSttModel(OR, undefined)).toBe(OR);
	});
	it("OpenRouter: aplica id com vendor", () => {
		expect(applyUserSttModel(OR, "elevenlabs/scribe-v2").model).toBe("elevenlabs/scribe-v2");
	});
	it("OpenRouter: id sem vendor é ignorado", () => {
		expect(applyUserSttModel(OR, "whisper-1").model).toBe(OR.model);
	});
	it("OpenAI direto: só a lista fixa", () => {
		expect(applyUserSttModel(OA, "whisper-1").model).toBe("whisper-1");
		expect(applyUserSttModel(OA, "elevenlabs/scribe-v2").model).toBe(OA.model);
		expect(OPENAI_STT_MODELS.map((m) => m.id)).toEqual(["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"]);
	});
});
