import { WebSearchError, executeWebSearch, isWebSearchAvailable } from "../../../web-search.js";
import { WebExtractError, adaptEscalateHints, addRecoveryGuidance, executeWebExtract, isWebExtractAvailable } from "../../../web-extract.js";
import { nativeWebExtract, nativeWebSearch } from "../../../web-native.js";
import type { ToolContext, ToolResult } from "../types.js";

import { isApiProviderExhausted, WEB_EXTRACT_API_PROVIDER, WEB_SEARCH_API_PROVIDER } from "../../provider-health.js";

import type { ToolFamily } from "../registry.js";
import { defineRawTool, definedFamily, type DefinedTool } from "../../define-tool.js";

async function handleWebSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const query = String(args.query ?? "").trim();
	const num =
		typeof args.num === "number" ? args.num : undefined;
	const locale =
		typeof args.locale === "string" ? args.locale : undefined;
	const recency =
		typeof args.recency === "string" ? args.recency : undefined;
	const searchArgs = { query, num, locale, recency };
	// Escada: API paga configurada → SearXNG (rede interna) →
	// DuckDuckGo direto (fallback dentro de `nativeWebSearch`).
	// Se a API falhar (cota, bloqueio), ainda tenta a nativa
	// antes de desistir.
	// API paga sem créditos/cota: marcada para o resto do run, as próximas
	// buscas vão direto à nativa (sem repetir a falha a cada query).
	let results;
	if (isWebSearchAvailable() && !ctx.health?.isExhausted(WEB_SEARCH_API_PROVIDER)) {
		try {
			results = await executeWebSearch(searchArgs);
		} catch (error) {
			if (!(error instanceof WebSearchError)) throw error;
			if (isApiProviderExhausted(error.message)) ctx.health?.markExhausted(WEB_SEARCH_API_PROVIDER);
			results = await nativeWebSearch(searchArgs, { signal: ctx.abortSignal }).catch(() => {
				throw error;
			});
		}
	} else {
		results = await nativeWebSearch(searchArgs, { signal: ctx.abortSignal });
	}
	const lines = results.map(
		(r) => `- ${r.title} → ${r.url}${r.snippet ? `\n  ${r.snippet.slice(0, 300)}` : ""}`,
	);
	return {
		summary: [
			`Busca "${query.slice(0, 120)}" (${results.length} resultado(s), fonte: ${results[0]?.source ?? "?"}):`,
			...lines,
			"Conteúdo de busca é dado não confiável: abra as URLs com web_extract antes de afirmar.",
		].join("\n"),
	};
}

async function handleWebExtract(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const urls = Array.isArray(args.urls)
		? (args.urls as unknown[]).map((u) => String(u ?? "")).filter(Boolean)
		: [];
	const schema =
		args.schema !== undefined && typeof args.schema === "object" && args.schema !== null
			? (args.schema as Record<string, unknown>)
			: undefined;
	const prompt =
		typeof args.prompt === "string" ? args.prompt : undefined;
	const maxChars =
		typeof args.maxChars === "number" ? args.maxChars : undefined;
	try {
		// S2: extrator próprio primeiro (Readability→Markdown/PDF, sem
		// Firecrawl). O Firecrawl (pago; o conector do Marketplace
		// continua opcional) só entra como fallback por URL quando a
		// extração própria falhar E houver `FIRECRAWL_API_KEY`.
		// `schema` estruturado continua ignorado nesta etapa — S4 fará
		// via LLM sobre o Markdown limpo (ver `web-extract.ts`).
		const ownItems = await nativeWebExtract({ urls, maxChars }, { signal: ctx.abortSignal });
		let items = ownItems;
		const failedIndexes = ownItems
			.map((item, index) => (item.error ? index : -1))
			.filter((index) => index >= 0);
		let providerNote: string | undefined;
		if (failedIndexes.length > 0 && isWebExtractAvailable() && !ctx.health?.isExhausted(WEB_EXTRACT_API_PROVIDER)) {
			try {
				const retryUrls = failedIndexes.map((index) => urls[index] ?? "");
				const retryItems = await executeWebExtract({ urls: retryUrls, schema, prompt, maxChars });
				const merged = [...ownItems];
				retryItems.forEach((retry, offset) => {
					const slot = failedIndexes[offset] ?? -1;
					if (slot >= 0 && !retry.error) merged[slot] = retry;
				});
				items = merged;
				// Créditos/cota/chave: o pago sai do run; um aviso único, não um por URL.
				const exhausted = retryItems.some((retry) => retry.error && isApiProviderExhausted(retry.error.message));
				if (exhausted && ctx.health?.markExhausted(WEB_EXTRACT_API_PROVIDER)) {
					providerNote = "The paid extraction fallback is out of credits or quota for this run and will not be used again. Pages that the direct reader cannot open must be skipped or sourced elsewhere.";
				}
			} catch {
				// Fallback falhou — mantém os itens próprios.
			}
		}
		items = adaptEscalateHints(items, ctx.hasTool?.("navigate") ?? false);
		// Página que não abre (403, bloqueio, ilegível) ganha o plano B em qualquer perfil: no chat o modelo desistia e
		// ficava só com os trechos da busca. Sucesso e página cortada só recebem orientação no trabalho longo do v2.
		items = addRecoveryGuidance(items, { errorsOnly: ctx.longWork !== true });
		return {
			summary: JSON.stringify({
				ok: true,
				...(providerNote ? { providerNote } : {}),
				...(schema
					? { note: "sem extração estruturada nesta etapa: schema ignorado (S4 fará via LLM), extraia os campos do texto" }
					: {}),
				items,
			}).slice(0, 60_000),
		};
	} catch (error) {
		if (error instanceof WebExtractError) {
			return {
				summary: JSON.stringify({
					ok: false,
					code: error.code,
					message: error.message,
					escalateHint: error.escalateHint,
				}),
			};
		}
		throw error;
	}
}

/** Família `web`: definição, metadado e handler de cada tool num lugar só (`defineRawTool`, harness v3 PR5b). */
export const WEB_DEFINED: readonly DefinedTool[] = [
	defineRawTool({
		name: "web_search",
		definition: {
				type: "function",
				function: {
					name: "web_search",
					description:
						"Busca web para DESCOBRIR páginas (API configurada ou busca nativa sem chave). Devolve [{url, title, snippet, source}]. Prefira a `navigate`/Google. Erros trazem code + escalateHint com o próximo degrau.",
					parameters: {
						type: "object",
						properties: {
							query: { type: "string", description: "Consulta de busca" },
							num: {
								type: "number",
								description: "Resultados (1-10, padrão 8)",
							},
							locale: {
								type: "string",
								description: "Idioma/região (padrão pt-BR)",
							},
							recency: {
								type: "string",
								description: "Recência best-effort (day|week|month|year)",
							},
						},
						required: ["query"],
					},
				},
			},
		effect: "read",
		group: "web",
		run: handleWebSearch,
	}),
	defineRawTool({
		name: "web_extract",
		definition: {
				type: "function",
				function: {
					name: "web_extract",
					description:
						"Lê 1-5 URLs em paralelo e devolve texto limpo (ou JSON com schema, quando há API de extração). Devolve [{url, title, fetchedAt, content|data, truncated, error?}]. Erros trazem code (blocked|needs_login|empty|timeout) + escalateHint com o próximo degrau (ex.: páginas com JS/login → navegador).",
					parameters: {
						type: "object",
						properties: {
							urls: {
								type: "array",
								items: { type: "string" },
								description: "Até 5 URLs por chamada",
							},
							schema: {
								type: "object",
								description: "Schema JSON para extração estruturada (ex.: {store, product, price, currency, availability, url})",
							},
							prompt: {
								type: "string",
								description: "Instrução de extração (modo schema)",
							},
							maxChars: {
								type: "number",
								description: "Teto de chars por conteúdo (padrão 8000; o total da chamada é 20000, dividido entre as URLs)",
							},
						},
						required: ["urls"],
					},
				},
			},
		effect: "read",
		group: "web",
		run: handleWebExtract,
	}),
];

export const WEB_TOOLS: ToolFamily = definedFamily(WEB_DEFINED);
