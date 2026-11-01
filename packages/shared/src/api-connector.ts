import type { ConnectorGuideView } from "./connector-guide.js";
/**
 * Conector de API genérico a partir de uma especificação OpenAPI 3 / Swagger 2
 * (etapa 1: somente leitura). Tudo aqui é puro e sem I/O: interpreta o
 * documento já baixado, monta a URL de uma operação do catálogo contra a base
 * fixada e busca operações. Download, rede e segredos ficam no agent-runtime.
 */

import { parseCustomMcpUrl } from "./login-connector.js";

export type ApiAuthKind = "oauth2" | "apiKey" | "bearer" | "none";

export type ApiAuth = {
	kind: ApiAuthKind;
	/** oauth2 (authorization code) */
	authorizeUrl?: string;
	tokenUrl?: string;
	/** Endpoint de revogação, só quando a spec o declara (`x-revocation-url`). */
	revokeUrl?: string;
	scopes?: string[];
	/** O servidor de autorização aceita PKCE (S256); detectado pelos metadados na conexão. */
	pkce?: boolean;
	/** apiKey: onde a chave vai e com que nome. */
	in?: "header" | "query";
	name?: string;
};

export type ApiParamType = "string" | "number" | "integer" | "boolean" | "array" | "object";

export type ApiParam = {
	name: string;
	in: "path" | "query";
	required: boolean;
	type: ApiParamType;
	enum?: string[];
	description?: string;
};

export type ApiMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ApiOperation = {
	id: string;
	method: ApiMethod;
	/** Template de caminho relativo à base (`/pedidos/vendas/{idPedidoVenda}`). */
	path: string;
	summary: string;
	tag: string;
	params: ApiParam[];
	/** A operação aceita corpo (irrelevante na etapa 1, guardado para a etapa de escrita). */
	body: boolean;
};

export type ApiGroup = { tag: string; total: number; read: number; write: number };

export type ParsedApiSpec = {
	title: string;
	description: string;
	baseUrl: string;
	auth: ApiAuth;
	operations: ApiOperation[];
};

export type ParseApiSpecResult = { ok: true; spec: ParsedApiSpec } | { ok: false; error: string };

/** Etapa 1: só leitura. A execução sempre reconfere, o catálogo guarda tudo. */
export const API_READ_METHODS: readonly ApiMethod[] = ["GET", "HEAD"];

export const API_LIMITS = {
	operations: 3000,
	paramsPerOperation: 40,
	summary: 200,
	description: 300,
	title: 80,
	idChars: 80,
	tagChars: 60,
	pathChars: 300,
	connectionName: 60,
} as const;

const METHODS: readonly ApiMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number): string {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Resolve `$ref` local (`#/a/b`); ciclos e referências externas viram `null`. */
function resolveRef(root: Json, node: unknown, depth = 0): Json | null {
	if (!isObject(node)) return null;
	const ref = node.$ref;
	if (typeof ref !== "string") return node;
	if (depth > 8 || !ref.startsWith("#/")) return null;
	let current: unknown = root;
	for (const part of ref.slice(2).split("/")) {
		if (!isObject(current)) return null;
		current = current[part.replace(/~1/g, "/").replace(/~0/g, "~")];
	}
	return resolveRef(root, current, depth + 1);
}

function paramType(raw: unknown): ApiParamType {
	return raw === "number" || raw === "integer" || raw === "boolean" || raw === "array" || raw === "object" ? raw : "string";
}

function toParam(root: Json, raw: unknown): ApiParam | null {
	const node = resolveRef(root, raw);
	if (!node) return null;
	const where = node.in;
	if (where !== "path" && where !== "query") return null;
	const name = str(node.name, 80);
	if (!name) return null;
	const schema = resolveRef(root, node.schema) ?? node;
	const values = Array.isArray(schema.enum) ? schema.enum.filter((item) => typeof item === "string" || typeof item === "number").map(String).slice(0, 50) : [];
	const description = str(node.description, 160);
	return {
		name,
		in: where,
		required: where === "path" ? true : node.required === true,
		type: paramType(schema.type),
		...(values.length ? { enum: values } : {}),
		...(description ? { description } : {}),
	};
}

function operationSlug(method: string, path: string): string {
	const body = path.replace(/[{}]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return `${method.toLowerCase()}_${body || "root"}`.slice(0, API_LIMITS.idChars);
}

function cleanId(raw: unknown): string {
	return typeof raw === "string" ? raw.trim().replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, API_LIMITS.idChars) : "";
}

function expandServerUrl(server: unknown, specUrl: string): string | null {
	if (!isObject(server) || typeof server.url !== "string") return null;
	let url = server.url;
	const variables = isObject(server.variables) ? server.variables : {};
	url = url.replace(/\{([^}]+)\}/g, (_all, name: string) => {
		const variable = variables[name];
		return isObject(variable) && typeof variable.default === "string" ? variable.default : "";
	});
	try {
		return new URL(url, specUrl).toString();
	} catch {
		return null;
	}
}

function baseUrlOf(doc: Json, specUrl: string): string | null {
	if (typeof doc.swagger === "string") {
		const schemes = Array.isArray(doc.schemes) ? doc.schemes.filter((item): item is string => typeof item === "string") : [];
		const scheme = schemes.includes("https") ? "https" : schemes[0] ?? new URL(specUrl).protocol.replace(":", "");
		const host = typeof doc.host === "string" && doc.host ? doc.host : new URL(specUrl).host;
		const basePath = typeof doc.basePath === "string" ? doc.basePath : "";
		return `${scheme}://${host}${basePath}`;
	}
	const servers = Array.isArray(doc.servers) ? doc.servers : [];
	if (!servers.length) return new URL(specUrl).origin;
	// Determinístico: o primeiro servidor que não se descreve como teste/sandbox/documentação; senão o primeiro.
	const production = servers.find((server) => !(isObject(server) && SANDBOX_HINT.test(str(server.description, 200)))) ?? servers[0];
	return expandServerUrl(production, specUrl);
}

/** Texto que marca ambiente de teste (servidor ou esquema de login): "teste", "test", "sandbox", "docs", "homologação"... */
const SANDBOX_HINT = /\b(test[a-z]*|sandbox|docs?|document\w*|homolog\w*|staging|demo)\b/i;

const authRank: Record<ApiAuthKind, number> = { oauth2: 0, apiKey: 1, bearer: 2, none: 3 };

function toAuth(scheme: unknown): ApiAuth | null {
	if (!isObject(scheme)) return null;
	const type = scheme.type;
	if (type === "oauth2") {
		// v3: flows.authorizationCode; v2: flow "accessCode" (authorization code).
		const flows = isObject(scheme.flows) ? scheme.flows : null;
		const flow = flows ? flows.authorizationCode : scheme.flow === "accessCode" ? scheme : null;
		if (!isObject(flow)) return null;
		const authorizeUrl = str(flow.authorizationUrl, 500);
		const tokenUrl = str(flow.tokenUrl, 500);
		if (!authorizeUrl || !tokenUrl) return null;
		const scopes = isObject(flow.scopes) ? Object.keys(flow.scopes).slice(0, 100) : [];
		const revokeUrl = str(scheme["x-revocation-url"] ?? flow["x-revocation-url"], 500);
		return { kind: "oauth2", authorizeUrl, tokenUrl, scopes, ...(revokeUrl ? { revokeUrl } : {}) };
	}
	if (type === "apiKey") {
		const where = scheme.in === "query" ? "query" : scheme.in === "header" ? "header" : null;
		const name = str(scheme.name, 80);
		return where && /^[A-Za-z0-9_.-]+$/.test(name) ? { kind: "apiKey", in: where, name } : null;
	}
	if (type === "http" && typeof scheme.scheme === "string" && scheme.scheme.toLowerCase() === "bearer") return { kind: "bearer" };
	return null;
}

function hostPath(url: string | undefined): { host: string; path: string[] } | null {
	try {
		const parsed = new URL(url ?? "");
		return { host: parsed.hostname.toLowerCase(), path: parsed.pathname.toLowerCase().split("/").filter(Boolean) };
	} catch {
		return null;
	}
}

/** Menor é melhor: sem marca de sandbox, mesmo host/domínio do servidor de produção e mais caminho em comum com a base. */
function oauthScore(name: string, scheme: unknown, auth: ApiAuth, baseUrl: string | null): number {
	const description = isObject(scheme) ? str(scheme.description, 200) : "";
	let score = SANDBOX_HINT.test(`${name} ${description}`) ? 1000 : 0;
	const token = hostPath(auth.tokenUrl);
	if (token && SANDBOX_HINT.test(`${token.host.split(".").slice(0, -2).join(" ")} ${token.path.join(" ")}`)) score += 500;
	const base = hostPath(baseUrl ?? undefined);
	if (token && base) {
		const domain = (host: string) => host.split(".").slice(-2).join(".");
		if (token.host !== base.host) score += domain(token.host) === domain(base.host) ? 10 : 100;
		let shared = 0;
		while (shared < base.path.length && base.path[shared] === token.path[shared]) shared++;
		score -= shared;
	}
	return score;
}

function pickAuth(doc: Json, baseUrl: string | null): ApiAuth {
	const components = isObject(doc.components) ? doc.components : {};
	const schemes = (isObject(components.securitySchemes) ? components.securitySchemes : isObject(doc.securityDefinitions) ? doc.securityDefinitions : {}) as Json;
	const referenced: string[] = [];
	for (const requirement of Array.isArray(doc.security) ? doc.security : []) {
		if (isObject(requirement)) referenced.push(...Object.keys(requirement));
	}
	const names = [...new Set([...referenced, ...Object.keys(schemes)])];
	const found = names
		.map((name, order) => ({ auth: toAuth(schemes[name]), name, order }))
		.filter((item): item is { auth: ApiAuth; name: string; order: number } => item.auth !== null)
		.map((item) => ({ ...item, score: item.auth.kind === "oauth2" ? oauthScore(item.name, schemes[item.name], item.auth, baseUrl) : 0 }));
	// Tipo mais completo primeiro; entre OAuth2, o login de produção; depois a ordem declarada.
	found.sort((a, b) => authRank[a.auth.kind] - authRank[b.auth.kind] || a.score - b.score || a.order - b.order);
	return found[0]?.auth ?? { kind: "none" };
}

/** Interpreta um documento OpenAPI 3.x ou Swagger 2.0 já em objeto. */
export function parseOpenApiDocument(raw: unknown, input: { specUrl: string; allowLocal?: boolean }): ParseApiSpecResult {
	if (!isObject(raw)) return { ok: false, error: "O documento não é uma especificação OpenAPI." };
	const doc = raw;
	const version = typeof doc.openapi === "string" ? doc.openapi : typeof doc.swagger === "string" ? doc.swagger : "";
	if (!/^(3\.\d+(\.\d+)?|2\.0)$/.test(version)) return { ok: false, error: "Versão não suportada: use OpenAPI 3.x ou Swagger 2.0." };
	if (!isObject(doc.paths)) return { ok: false, error: "A especificação não tem caminhos (paths)." };

	const baseRaw = baseUrlOf(doc, input.specUrl);
	const base = baseRaw ? parseCustomMcpUrl(baseRaw.replace(/\/+$/, ""), { allowLocal: input.allowLocal }) : null;
	if (!base?.ok) return { ok: false, error: `Endereço base da API inválido ou não público${base && !base.ok ? ` (${base.error})` : ""}.` };
	const baseUrl = base.url.toString().replace(/\/+$/, "");

	const info = isObject(doc.info) ? doc.info : {};
	const title = str(info.title, API_LIMITS.title) || new URL(baseUrl).hostname;
	const operations: ApiOperation[] = [];
	const usedIds = new Set<string>();

	for (const [path, item] of Object.entries(doc.paths)) {
		if (!path.startsWith("/") || path.startsWith("//") || path.length > API_LIMITS.pathChars || !isObject(item)) continue;
		const shared = Array.isArray(item.parameters) ? item.parameters : [];
		for (const method of METHODS) {
			const op = item[method.toLowerCase()];
			if (!isObject(op)) continue;
			if (operations.length >= API_LIMITS.operations) break;
			const own = Array.isArray(op.parameters) ? op.parameters : [];
			const merged = new Map<string, ApiParam>();
			for (const rawParam of [...shared, ...own]) {
				const param = toParam(doc, rawParam);
				if (param) merged.set(`${param.in}:${param.name}`, param);
			}
			const params = [...merged.values()].slice(0, API_LIMITS.paramsPerOperation);
			// Todo `{x}` do caminho precisa existir como parâmetro: senão a operação não é chamável.
			for (const match of path.matchAll(/\{([^}]+)\}/g)) {
				const name = match[1]!;
				if (!params.some((param) => param.in === "path" && param.name === name)) {
					params.push({ name, in: "path", required: true, type: "string" });
				}
			}
			const tags = Array.isArray(op.tags) ? op.tags.filter((tag): tag is string => typeof tag === "string") : [];
			const tag = str(tags[0], API_LIMITS.tagChars) || str(path.split("/").filter(Boolean)[0]?.replace(/[{}]/g, ""), API_LIMITS.tagChars) || "Geral";
			let id = cleanId(op.operationId) || operationSlug(method, path);
			for (let n = 2; usedIds.has(id); n += 1) id = `${id.slice(0, API_LIMITS.idChars - 4)}_${n}`;
			usedIds.add(id);
			const bodyParam = own.some((entry) => isObject(entry) && entry.in === "body");
			operations.push({
				id,
				method,
				path,
				summary: str(op.summary, API_LIMITS.summary) || str(op.description, API_LIMITS.summary) || id,
				tag,
				params,
				body: op.requestBody !== undefined || bodyParam,
			});
		}
	}
	if (operations.length === 0) return { ok: false, error: "A especificação não tem operações utilizáveis." };

	return {
		ok: true,
		spec: {
			title,
			description: str(info.description, API_LIMITS.description),
			baseUrl,
			auth: pickAuth(doc, baseUrl),
			operations,
		},
	};
}

export function isReadMethod(method: string): boolean {
	return (API_READ_METHODS as readonly string[]).includes(method.toUpperCase());
}

/** Grupos (tags) com a contagem de operações de leitura e de escrita. */
export function summarizeApiGroups(operations: readonly ApiOperation[]): ApiGroup[] {
	const groups = new Map<string, ApiGroup>();
	for (const op of operations) {
		const group = groups.get(op.tag) ?? { tag: op.tag, total: 0, read: 0, write: 0 };
		group.total += 1;
		if (isReadMethod(op.method)) group.read += 1;
		else group.write += 1;
		groups.set(op.tag, group);
	}
	return [...groups.values()].sort((a, b) => a.tag.localeCompare(b.tag, "pt-BR"));
}

/** Operações que a conexão permite: leitura nos grupos liberados. */
export function allowedApiOperations(operations: readonly ApiOperation[], allowedTags: readonly string[]): ApiOperation[] {
	const tags = new Set(allowedTags);
	return operations.filter((op) => isReadMethod(op.method) && tags.has(op.tag));
}

/** Grupos que o usuário pode liberar na etapa 1 (os que têm ao menos uma leitura). */
export function readableApiTags(operations: readonly ApiOperation[]): string[] {
	return summarizeApiGroups(operations).filter((group) => group.read > 0).map((group) => group.tag);
}

export type BuiltApiRequest = { url: URL; method: ApiMethod };

function scalar(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	return null;
}

/**
 * Monta a URL de uma operação do catálogo contra a base fixada. Nunca aceita
 * host, esquema ou caminho vindos do modelo: só valores dos parâmetros
 * declarados, com os de caminho codificados.
 */
export function buildApiRequestUrl(baseUrl: string, op: ApiOperation, rawArgs: unknown): BuiltApiRequest {
	const args = isObject(rawArgs) ? rawArgs : {};
	const declared = new Map(op.params.map((param) => [param.name, param] as const));
	for (const key of Object.keys(args)) {
		if (!declared.has(key)) {
			const names = op.params.map((param) => param.name).join(", ") || "nenhum";
			throw new Error(`Parâmetro desconhecido "${key}" em ${op.id}. Parâmetros aceitos: ${names}.`);
		}
	}
	let path = op.path;
	for (const param of op.params.filter((item) => item.in === "path")) {
		const value = scalar(args[param.name]);
		if (value === null || value === "") throw new Error(`Falta o parâmetro de caminho "${param.name}" em ${op.id}.`);
		if (value === "." || value === ".." || value.length > 200) throw new Error(`Valor inválido para "${param.name}".`);
		path = path.split(`{${param.name}}`).join(encodeURIComponent(value));
	}
	const base = new URL(baseUrl);
	const url = new URL(`${base.origin}${base.pathname.replace(/\/+$/, "")}${path}`);
	for (const param of op.params.filter((item) => item.in === "query")) {
		const value = args[param.name];
		if (value === undefined || value === null || value === "") {
			if (param.required) throw new Error(`Falta o parâmetro "${param.name}" em ${op.id}.`);
			continue;
		}
		const items = Array.isArray(value) ? value : [value];
		for (const item of items) {
			const text = scalar(item);
			if (text === null) throw new Error(`Valor inválido para "${param.name}": use texto, número ou booleano.`);
			if (param.enum && !param.enum.includes(text)) throw new Error(`Valor inválido para "${param.name}": use um de ${param.enum.join(", ")}.`);
			url.searchParams.append(param.name, text);
		}
	}
	// Defesa final: nada que a montagem faça pode sair da base fixada.
	if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/+$/, "") + "/")) {
		throw new Error("Caminho fora da API conectada.");
	}
	return { url, method: op.method };
}

function normalizeText(text: string): string {
	return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Busca simples e determinística: palavras da consulta contra id, tag, caminho e resumo. */
export function searchApiOperations(operations: readonly ApiOperation[], query: string, limit = 12): ApiOperation[] {
	const words = normalizeText(query).split(/[^a-z0-9]+/).filter((word) => word.length >= 2);
	if (words.length === 0) return operations.slice(0, limit);
	const scored: Array<{ op: ApiOperation; score: number }> = [];
	for (const op of operations) {
		const id = normalizeText(op.id);
		const tag = normalizeText(op.tag);
		const path = normalizeText(op.path);
		const summary = normalizeText(op.summary);
		let score = 0;
		for (const word of words) {
			if (id.includes(word)) score += 4;
			if (tag.includes(word)) score += 3;
			if (path.includes(word)) score += 2;
			if (summary.includes(word)) score += 2;
		}
		if (score > 0) scored.push({ op, score });
	}
	return scored.sort((a, b) => b.score - a.score || a.op.id.localeCompare(b.op.id)).slice(0, limit).map((item) => item.op);
}

/** Linha compacta de uma operação para o modelo: `id METHOD path (parâmetros*) resumo`. */
export function formatApiOperation(op: ApiOperation): string {
	const params = op.params.map((param) => `${param.name}${param.required ? "*" : ""}${param.in === "path" ? "@" : ""}`).join(",");
	return `${op.id} ${op.method} ${op.path}${params ? ` (${params})` : ""} - ${op.summary}`;
}

/** Slug estável da conexão: "Bling" vira "bling". */
export function slugifyApiName(name: string): string {
	const slug = normalizeText(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
	return slug || "api";
}

/** Tira a pontuação final (laço linear; a regex /[.,;:!?]+$/ era quadrática com milhares de "!"). */
function trimTrailingPunctuation(url: string): string {
	let end = url.length;
	while (end > 0 && ".,;:!?".includes(url[end - 1]!)) end--;
	return url.slice(0, end);
}

/** Extrai URLs http(s) de um texto (última fala do usuário), sem pontuação final. */
export function extractUrls(text: string): string[] {
	const urls: string[] = [];
	for (const match of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)) {
		urls.push(trimTrailingPunctuation(match[0]));
	}
	return urls;
}

function comparableUrl(raw: string): string | null {
	try {
		const url = new URL(raw);
		url.hash = "";
		return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
	} catch {
		return null;
	}
}

/** A URL pedida pelo modelo aparece na fala do próprio usuário? (nunca vale URL vinda de web/tool). */
export function urlInUserText(url: string, userText: string): boolean {
	const wanted = comparableUrl(url);
	if (!wanted) return false;
	return extractUrls(userText).some((candidate) => comparableUrl(candidate) === wanted);
}

/** Dados do card "Conectar API": só o que o usuário precisa ver para decidir (nada de segredo). */
export type ApiProposal = {
	specUrl: string;
	name: string;
	/** Domínio da API (host da base fixada). */
	domain: string;
	baseUrl: string;
	authKind: ApiAuthKind;
	/** apiKey: onde a chave vai (`header X-Api-Key`). */
	authDetail?: string;
	operationCount: number;
	readCount: number;
	groups: ApiGroup[];
	/** Para OAuth2: a URL exata a cadastrar no portal do provedor. */
	redirectUrl?: string;
	/** A base da API fica em outro domínio que o da especificação (merece atenção). */
	crossHost?: boolean;
	/** O link veio do bot (não digitado pelo usuário): o card mostra o domínio para conferir. */
	foundByBot?: boolean;
};

/** Pedido curto de confirmação ("conecta pra mim", "pode conectar", "sim"), sem outro link. */
export function isShortConnectConfirmation(text: string): boolean {
	const plain = text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.trim();
	if (!plain || plain.length > 60 || plain.includes("?") || /https?:\/\/|www\./.test(plain)) return false;
	return /\b(conect\w*|pode|sim|isso|ok|okay|bora|vai|claro|quero|faz|manda|certo|beleza|positivo|yes)\b/.test(plain);
}

export function describeApiAuth(auth: ApiAuth): string | undefined {
	if (auth.kind === "apiKey") return `${auth.in === "query" ? "parâmetro" : "cabeçalho"} ${auth.name}`;
	return undefined;
}

export const API_AUTH_LABEL: Record<ApiAuthKind, string> = {
	oauth2: "Entrar com a conta",
	apiKey: "Chave de acesso",
	bearer: "Código de acesso",
	none: "Sem login",
};

/** Visão da conexão para a UI (sem segredos e sem o catálogo completo). */
export type ApiConnectionStatus = "pending_auth" | "connected" | "error" | "disabled";

export type ApiConnectionView = {
	id: string;
	slug: string;
	name: string;
	domain: string;
	baseUrl: string;
	authKind: ApiAuthKind;
	status: ApiConnectionStatus;
	lastError: string | null;
	groups: ApiGroup[];
	allowedTags: string[];
	operationCount: number;
	rateLimitRps: number;
	/** Apelido da conta (várias contas na mesma API); null = sem apelido. */
	accountLabel: string | null;
	/** Guia de uso da API (dado não confiável); null = ainda não gerado. */
	guide?: ConnectorGuideView | null;
	createdAt: string;
	updatedAt: string;
};

export const API_DEFAULT_RATE_LIMIT_RPS = 3;
export const API_MAX_RATE_LIMIT_RPS = 20;

export function clampRateLimit(value: unknown): number {
	const number = typeof value === "number" && Number.isFinite(value) ? value : API_DEFAULT_RATE_LIMIT_RPS;
	return Math.min(API_MAX_RATE_LIMIT_RPS, Math.max(1, Math.round(number)));
}
