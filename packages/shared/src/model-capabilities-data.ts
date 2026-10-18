import type { ModelProvider } from "./model-ref.js";

/** Capacidades que um override curado pode afirmar. Campo ausente = deixa para o catálogo/heurística. */
export type ModelCapabilityFields = {
	vision?: boolean;
	/** PDF nativo (o provedor lê o arquivo como documento, sem extrair texto antes). */
	pdf?: boolean;
	tools?: boolean;
	reasoning?: boolean;
	contextTokens?: number;
	maxOutputTokens?: number;
	streaming?: boolean;
};

/**
 * Regra curada e versionada. `slug` casa com o nome do modelo sem vendor nem sufixo de
 * variante ("claude-haiku-5.5", "gpt-5.1", "gemini-2.5-pro"); `providers` restringe por
 * provedor de inferência. A primeira regra que casa vence, então as específicas vêm antes.
 * No OpenRouter, "claude-*", "gpt-*" e "gemini-*" só valem com o vendor certo.
 */
export type ModelCapabilityRule = {
	slug: RegExp;
	providers?: readonly ModelProvider[];
	caps: ModelCapabilityFields;
};

const CLAUDE_PROVIDERS: readonly ModelProvider[] = ["openrouter", "anthropic"];

export const MODEL_CAPABILITY_OVERRIDES: readonly ModelCapabilityRule[] = [
	// Claude: lê imagem e PDF, tem ferramentas. Haiku 5.5 é o modelo de juiz/manutenção.
	{ slug: /^claude-haiku-5/, providers: CLAUDE_PROVIDERS, caps: { vision: true, pdf: true, tools: true, reasoning: true, streaming: true } },
	{ slug: /^claude-(3[.-]5-haiku|3-haiku)/, providers: CLAUDE_PROVIDERS, caps: { vision: true, pdf: true, tools: true, reasoning: false, streaming: true } },
	{ slug: /^claude-/, providers: CLAUDE_PROVIDERS, caps: { vision: true, pdf: true, tools: true, streaming: true } },
	// GPT por OpenRouter: 4o/4.1/5 leem imagem e arquivo; 3.5 é só texto.
	{ slug: /^gpt-3\.5/, providers: ["openrouter"], caps: { vision: false, pdf: false, tools: true, streaming: true } },
	{ slug: /^gpt-5/, providers: ["openrouter"], caps: { vision: true, pdf: true, tools: true, reasoning: true, streaming: true } },
	{ slug: /^gpt-(4o|4\.1|4\.5|4-turbo)/, providers: ["openrouter"], caps: { vision: true, pdf: true, tools: true, reasoning: false, streaming: true } },
	// Gemini por OpenRouter.
	{ slug: /^gemini-(2\.5|3)/, providers: ["openrouter"], caps: { vision: true, pdf: true, tools: true, reasoning: true, streaming: true } },
	{ slug: /^gemini-/, providers: ["openrouter"], caps: { vision: true, pdf: true, tools: true, streaming: true } },
	// Plano ChatGPT (assinatura): visão fica com o catálogo da conta (sem flag = tenta); PDF nativo não é oferecido.
	{ slug: /.*/, providers: ["chatgpt"], caps: { pdf: false, tools: true, reasoning: true, streaming: true } },
	// OpenCode Go: visão só quando o catálogo declara (modelo de texto responde 400 a imagem).
	{ slug: /.*/, providers: ["opencode-go"], caps: { pdf: false, tools: true, streaming: true } },
];
