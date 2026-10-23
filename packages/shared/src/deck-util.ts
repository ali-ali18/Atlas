/**
 * Auxiliares de validação dos slides (`deck.ts`, `deck-free.ts`). Só funções puras.
 */
import { parseChartSpec, type ChartSpec } from "./chart-spec.js";

export const DECK_MAX_CHART_POINTS = 40;
/** Gráficos que viram gráfico nativo do PowerPoint. */
export const DECK_CHART_TYPES = ["bar", "line", "area", "pie"] as const;

export function fail(message: string): never {
	throw new Error(message);
}

export function str(value: unknown, max: number, label: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" && typeof value !== "number") fail(`${label} must be a string.`);
	const text = String(value).trim();
	if (!text) return undefined;
	if (text.length > max) fail(`${label} is too long (max ${max} characters).`);
	return text;
}

export function need(value: unknown, max: number, label: string): string {
	return str(value, max, label) ?? fail(`${label} is required.`);
}

export function obj(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
	return value as Record<string, unknown>;
}

export function list(value: unknown, label: string, min: number, max: number): unknown[] {
	if (!Array.isArray(value)) fail(`${label} must be an array.`);
	if (value.length < min) fail(`${label} needs at least ${min} item${min > 1 ? "s" : ""}.`);
	if (value.length > max) fail(`${label} has too many items (max ${max}).`);
	return value;
}

/** Id de anexo ou de imagem gerada (`attachment:`/`artifact:` aceitos). URL não vale: o servidor não busca rede. */
export function parseDeckImageId(value: unknown, label: string): string {
	const raw = need(value, 200, label).replace(/^(attachment|artifact):/, "");
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith("data:")) {
		fail(`${label} must be the id of an attached or generated image, not a URL. Generate the image first (generate_image) or use an attachment id.`);
	}
	if (!/^[\w.-]{1,200}$/.test(raw)) fail(`${label} is not a valid image id.`);
	return raw;
}

export function parseChart(value: unknown, label: string): ChartSpec {
	const parsed = parseChartSpec(value);
	if (!parsed.ok) return fail(`${label} is invalid: ${parsed.error}.`);
	const spec = parsed.spec;
	if (!(DECK_CHART_TYPES as readonly string[]).includes(spec.type)) {
		fail(`${label}.type "${spec.type}" is not available in slides. Use one of: ${DECK_CHART_TYPES.join(", ")}.`);
	}
	if (spec.data.length > DECK_MAX_CHART_POINTS) fail(`${label} has too many points for a slide (max ${DECK_MAX_CHART_POINTS}); aggregate the data first.`);
	return spec;
}

