import yaml from "js-yaml";
import { parseOpenApiDocument, registrableDomain, type ParsedApiSpec } from "@workspace/shared";
import { safeHttpRequest, SafeHttpError, type SafeHttpDeps } from "./safe-http.js";

/**
 * Descoberta da especificação OpenAPI a partir de um link: o próprio link, os
 * links da página de documentação e caminhos comuns. JSON ou YAML, OpenAPI 3
 * e Swagger 2. Tudo pelo fetch seguro (SSRF, https, limites).
 */

export const SPEC_MAX_BYTES = 12_000_000;
const SPEC_TIMEOUT_MS = 25_000;
const MAX_ATTEMPTS = 10;

const COMMON_PATHS = [
	"/openapi.json",
	"/swagger.json",
	"/openapi.yaml",
	"/openapi.yml",
	"/swagger.yaml",
	"/v3/api-docs",
	"/api-docs",
	"/api/openapi.json",
	"/docs/openapi.json",
	"/swagger/v1/swagger.json",
	"/.well-known/openapi.json",
];

export type DiscoveredApi = {
	spec: ParsedApiSpec;
	/** URL de onde a especificação foi lida (a base do `$ref` relativo e do servidor). */
	specUrl: string;
	/** A base da API fica em outro domínio que o da especificação. */
	crossHost: boolean;
};

export type DiscoverDeps = SafeHttpDeps & { signal?: AbortSignal };

function tryParseDocument(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("{")) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return null;
		}
	}
	// HTML nunca é YAML útil.
	if (trimmed.startsWith("<")) return null;
	try {
		const value = yaml.load(trimmed);
		return value && typeof value === "object" ? value : null;
	} catch {
		return null;
	}
}

function isSpecLike(value: unknown): boolean {
	return typeof value === "object" && value !== null && ("openapi" in value || "swagger" in value);
}

/** Links para uma especificação dentro de uma página de documentação (Swagger UI, Redoc, anchors). */
export function findSpecLinks(html: string, baseUrl: string): string[] {
	const found = new Set<string>();
	const add = (href: string) => {
		const clean = href.replace(/&amp;/g, "&").trim();
		if (!clean || /^(javascript|data|mailto):/i.test(clean)) return;
		try {
			found.add(new URL(clean, baseUrl).toString());
		} catch {
			// href inválido: ignora.
		}
	};
	const patterns = [
		// Swagger UI: url: "/openapi.json" ou "url":"..."
		/["']?\burl["']?\s*[:=]\s*["']([^"']+\.(?:json|ya?ml)(?:\?[^"']*)?)["']/gi,
		// Redoc: spec-url="..."
		/\bspec-url\s*=\s*["']([^"']+)["']/gi,
		// Links e referências com openapi/swagger no nome.
		/\b(?:href|src|data-url)\s*=\s*["']([^"']*(?:openapi|swagger)[^"']*\.(?:json|ya?ml)(?:\?[^"']*)?)["']/gi,
		/["'](\/?[A-Za-z0-9_./-]*(?:openapi|swagger)[A-Za-z0-9_./-]*\.(?:json|ya?ml))["']/gi,
	];
	for (const pattern of patterns) {
		for (const match of html.matchAll(pattern)) {
			if (match[1]) add(match[1]);
		}
	}
	return [...found].slice(0, 8);
}

function hostOf(url: string): string {
	return new URL(url).hostname.toLowerCase();
}

function sameSite(a: string, b: string): boolean {
	const strip = (host: string) => host.split(".").slice(-2).join(".");
	return hostOf(a) === hostOf(b) || strip(hostOf(a)) === strip(hostOf(b));
}

function registrableOf(url: string | undefined): string | null {
	if (!url) return null;
	try {
		return registrableDomain(hostOf(url).replace(/\.$/, ""));
	} catch {
		return null;
	}
}

/**
 * Anti-phishing: o login OAuth2 só vale se o token for trocado no domínio da própria API
 * (as credenciais iriam para lá) e a tela de autorização for do mesmo dono (API, token ou
 * documentação). Lança com mensagem em pt-BR.
 */
export function assertCredentialDomains(spec: ParsedApiSpec, specUrl: string): void {
	if (spec.auth.kind !== "oauth2") return;
	const base = registrableOf(spec.baseUrl);
	const token = registrableOf(spec.auth.tokenUrl);
	const authorize = registrableOf(spec.auth.authorizeUrl);
	const docs = registrableOf(specUrl);
	if (token && base && token !== base) {
		throw new Error(`Por segurança não conectei: o login desta API usa outro domínio (${token}) que não é o da API (${base}). Suas credenciais iriam para lá.`);
	}
	if (authorize && ![base, token, docs].includes(authorize)) {
		throw new Error(`Por segurança não conectei: a tela de login fica em outro domínio (${authorize}) que não é o da API (${base ?? "?"}).`);
	}
}

/**
 * Baixa e interpreta a especificação. Lança `Error` com mensagem em pt-BR
 * (pode ir ao modelo e ao usuário: não traz conteúdo da página).
 */
export async function discoverOpenApiSpec(inputUrl: string, deps: DiscoverDeps = {}): Promise<DiscoveredApi> {
	let start: URL;
	try {
		start = new URL(inputUrl);
	} catch {
		throw new Error("URL inválida.");
	}
	if (start.protocol !== "https:") throw new Error("Use um link https.");
	if (start.username || start.password) throw new Error("O link não pode conter usuário ou senha.");

	const tried = new Set<string>();
	const queue: string[] = [start.toString()];
	let lastError = "";
	let sawSpecWithoutOperations = "";

	const enqueue = (url: string) => {
		if (!tried.has(url) && !queue.includes(url)) queue.push(url);
	};

	while (queue.length > 0 && tried.size < MAX_ATTEMPTS) {
		const url = queue.shift()!;
		tried.add(url);
		let response;
		try {
			response = await safeHttpRequest(
				url,
				{
					timeoutMs: SPEC_TIMEOUT_MS,
					maxBytes: SPEC_MAX_BYTES,
					signal: deps.signal,
					headers: { Accept: "application/json, application/yaml, text/yaml, text/html;q=0.8, */*;q=0.5", "User-Agent": "ApiConnector/1.0" },
				},
				deps,
			);
		} catch (error) {
			if (error instanceof SafeHttpError && error.code === "blocked" && url === start.toString()) throw new Error("Esse endereço não é permitido (rede interna ou privada).");
			if (deps.signal?.aborted) throw error;
			lastError = error instanceof Error ? error.message : "falha de rede";
			continue;
		}
		if (response.status < 200 || response.status >= 300 || response.truncated) {
			lastError = response.truncated ? "A especificação é grande demais." : `HTTP ${response.status}`;
			continue;
		}
		const document = tryParseDocument(response.text);
		if (isSpecLike(document)) {
			const parsed = parseOpenApiDocument(document, { specUrl: response.finalUrl });
			if (parsed.ok) {
				assertCredentialDomains(parsed.spec, response.finalUrl);
				return { spec: parsed.spec, specUrl: response.finalUrl, crossHost: !sameSite(parsed.spec.baseUrl, response.finalUrl) };
			}
			sawSpecWithoutOperations = parsed.error;
			continue;
		}
		// Página de documentação: segue os links de especificação dela e depois os caminhos comuns.
		for (const link of findSpecLinks(response.text, response.finalUrl)) enqueue(link);
		if (url === start.toString()) {
			for (const path of COMMON_PATHS) enqueue(new URL(path, start.origin).toString());
		}
	}
	if (sawSpecWithoutOperations) throw new Error(sawSpecWithoutOperations);
	throw new Error(`Não encontrei uma especificação OpenAPI/Swagger nesse link${lastError ? ` (${lastError})` : ""}. Peça ao usuário o link direto do arquivo openapi.json ou swagger.json.`);
}
