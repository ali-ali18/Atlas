/**
 * Prévia privada de um projeto web da sessão de código: regras puras (sem I/O) usadas pela tool do
 * agente e pelo proxy da API. A prévia mora num domínio separado do Atlas (`<id>.<base>`), nunca na
 * origem do Atlas: o JavaScript do projeto é código do usuário/modelo e não pode ver o cookie de login.
 */

/** Vida máxima de uma prévia desde o início (ou desde o último `preview_start`). */
export const PREVIEW_TTL_MS = 60 * 60_000;
export const PREVIEW_MIN_PORT = 1024;
export const PREVIEW_MAX_PORT = 65535;
/** Portas de controle do container (servidor da sessão e proxy/gateway de saída): nunca expostas. */
export const PREVIEW_BLOCKED_PORTS: readonly number[] = [3090, 3128, 3129];
export const PREVIEW_MAX_PATH_LENGTH = 200;

export type DevSessionPreview = {
	port: number;
	/** Caminho aberto ao entrar (sempre começa com `/`). */
	path: string;
	startedAt: string;
	expiresAt: string;
	/**
	 * Só no modo básico: o servidor do projeto já serve sob `/v1/previews/<id>/p/` (ex.: `vite --base`), então o proxy
	 * repassa o caminho com o prefixo. Sem isso o prefixo é tirado antes de repassar (servidor estático, caminhos relativos).
	 */
	basePrefixed?: boolean;
	/**
	 * Só no modo básico: segredo aleatório que vai no CAMINHO (`/v1/previews/<id>/p/<cap>/...`) e autentica a prévia sem cookie
	 * (a origem opaca do sandbox é cross-origin ao Atlas: scripts `type=module`/`crossorigin`, fontes e `fetch` saem sem credenciais).
	 * Gerado a cada `preview_start`, vence com a prévia e some com `preview_stop`.
	 */
	cap?: string;
	/** Quando o `cap` foi emitido (ISO). O `cap` morre `PREVIEW_CAP_MAX_LIFETIME_MS` depois, mesmo que a prévia seja renovada. */
	capIssuedAt?: string;
};

/** Vida máxima de um `cap` desde a emissão: renovar a prévia (`preview_start`) não o estende além disso; passado o prazo nasce um novo. */
export const PREVIEW_CAP_MAX_LIFETIME_MS = 4 * 60 * 60_000;

export function isPreviewPort(port: unknown): port is number {
	return (
		typeof port === "number" &&
		Number.isInteger(port) &&
		port >= PREVIEW_MIN_PORT &&
		port <= PREVIEW_MAX_PORT &&
		!PREVIEW_BLOCKED_PORTS.includes(port)
	);
}

/** Caminho relativo seguro para o redirect inicial; `null` se inválido (esquema, `//`, controle, tamanho). */
export function normalizePreviewPath(raw: unknown): string | null {
	if (raw === undefined || raw === null || raw === "") return "/";
	if (typeof raw !== "string" || raw.length > PREVIEW_MAX_PATH_LENGTH) return null;
	const path = raw.startsWith("/") ? raw : `/${raw}`;
	// eslint-disable-next-line no-control-regex
	if (path.startsWith("//") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return null;
	return path;
}

/** Domínio-base da prévia (`preview.example.com`, aceita `:porta`); `null` se vazio ou inválido. */
export function normalizePreviewBaseDomain(raw: string | undefined | null): string | null {
	const text = raw?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/^\*\./, "");
	if (!text) return null;
	return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/.test(text) ? text : null;
}

/** Id da prévia (= id da sessão de código, cuid) quando o `Host` é `<id>.<base>`; senão `null` (cai nas rotas normais). */
export function previewIdFromHost(host: string | undefined | null, baseDomain: string | null): string | null {
	if (!host || !baseDomain) return null;
	const lower = host.trim().toLowerCase();
	const suffix = `.${baseDomain}`;
	if (!lower.endsWith(suffix)) return null;
	const label = lower.slice(0, -suffix.length);
	return /^[a-z0-9]{20,40}$/.test(label) ? label : null;
}

/** Origem da prévia: `https://<id>.<base>` (o esquema segue o do Atlas). */
export function previewOrigin(input: { scheme: "http" | "https"; baseDomain: string; id: string }): string {
	return `${input.scheme}://${input.id}.${input.baseDomain}`;
}

/**
 * Modo básico (sem domínio de prévia): a prévia vive na origem do Atlas sob este prefixo, mas o documento roda numa
 * origem opaca (CSP `sandbox` sem `allow-same-origin`), então não alcança o cookie de login. O `cap` (segredo da prévia) faz
 * parte do caminho: URLs relativas o mantêm sozinhas e nenhum cookie é necessário.
 */
export function previewBasicPrefix(id: string, cap?: string): string {
	return cap ? `/v1/previews/${id}/p/${cap}/` : `/v1/previews/${id}/p/`;
}

/** O `cap` vale por `PREVIEW_CAP_MAX_LIFETIME_MS` desde a emissão, mesmo que a prévia seja renovada; sem data de emissão não vale. */
export function previewCapIsLive(issuedAt: string | undefined, now: number): boolean {
	const issued = issuedAt ? Date.parse(issuedAt) : Number.NaN;
	return Number.isFinite(issued) && issued <= now + 60_000 && now - issued < PREVIEW_CAP_MAX_LIFETIME_MS;
}

/** Forma do `cap`: 24 bytes aleatórios em base64url. */
export const PREVIEW_CAP_PATTERN = /^[A-Za-z0-9_-]{32}$/;

const PREVIEW_BASIC_PATH = /^\/v1\/previews\/([a-z0-9]{20,40})\/p(?:\/([^/]*)(\/.*)?)?$/;

/** `/v1/previews/<id>/p/<cap>[/resto]` → id, cap (`""` se faltar) e resto (sempre começa com `/`); `null` se o caminho não é do modo básico. */
export function parsePreviewBasicPath(pathname: string): { id: string; cap: string; rest: string } | null {
	const match = PREVIEW_BASIC_PATH.exec(pathname);
	return match ? { id: match[1]!, cap: match[2] ?? "", rest: match[3] ?? "/" } : null;
}

/** O resto repassado ao projeto não pode escapar do prefixo nem conter separadores ambíguos (`//`, `\`, `%2f`, `%5c`, `..`/`%2e`, NUL/controle). */
export function isSafePreviewRest(rest: string): boolean {
	// eslint-disable-next-line no-control-regex
	if (rest.includes("//") || rest.includes("\\") || /%(?:2f|5c|00|0a|0d)/i.test(rest) || /[\u0000-\u001f\u007f]/.test(rest)) return false;
	return !rest.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
}

const PREVIEW_CAP_IN_TEXT = /(\/v1\/previews\/[a-z0-9]{20,40}\/p\/)[^/\s?#"'`<>\\]+/g;

/** Mascara o `cap` em qualquer texto (URL de evento do Sentry, saída de comando, log): `/p/<cap>/x` → `/p/:cap/x`. */
export function redactPreviewUrls(text: string): string {
	return text.replace(PREVIEW_CAP_IN_TEXT, "$1:cap");
}

/** Tira o `cap` do caminho para log/telemetria (`/p/<cap>/x` → `/p/:cap/x`). */
export function redactPreviewPath(path: string): string {
	return path.replace(/^(\/v1\/previews\/[a-z0-9]{20,40}\/p\/)[^/]+/, "$1:cap");
}

/** Sufixos de dois níveis comuns (heurística simples; não é a lista pública de sufixos completa). */
const TWO_LEVEL_SUFFIXES = new Set([
	"com.br", "net.br", "org.br", "gov.br", "edu.br", "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au",
	"co.jp", "co.nz", "co.za", "com.mx", "com.ar", "com.co", "com.pt", "com.cn", "co.in", "com.tr", "com.sg",
]);

/** Domínio registrável aproximado (últimos 2 rótulos, ou 3 em sufixos de dois níveis conhecidos). Sem porta. */
export function approxRegistrableDomain(host: string): string {
	const labels = host.trim().toLowerCase().replace(/:\d+$/, "").split(".").filter(Boolean);
	if (labels.length <= 2) return labels.join(".");
	const lastTwo = labels.slice(-2).join(".");
	return labels.slice(TWO_LEVEL_SUFFIXES.has(lastTwo) ? -3 : -2).join(".");
}

/**
 * Motivo para recusar o domínio-base da prévia: igual ao host do Atlas, pai dele ou no mesmo site
 * (mesmo domínio registrável). Mesmo site permite cookie com `Domain` amplo e CSRF same-site entre o
 * projeto e o Atlas. `null` = ok. Limitação: heurística sem a lista pública de sufixos; para um sufixo de
 * dois níveis desconhecido use `ATLAS_PREVIEW_ALLOW_SAME_SITE=1` por sua conta e risco (ou o inverso, um domínio separado).
 */
export function previewBaseDomainConflict(baseDomain: string, atlasUrl: string): string | null {
	let atlasHost: string;
	try {
		atlasHost = new URL(atlasUrl).hostname.toLowerCase();
	} catch {
		return null;
	}
	const base = baseDomain.toLowerCase().replace(/:\d+$/, "");
	if (base === atlasHost || atlasHost.endsWith(`.${base}`)) return "o domínio da prévia é o do Atlas ou um domínio pai dele";
	if (approxRegistrableDomain(base) === approxRegistrableDomain(atlasHost)) return "o domínio da prévia está no mesmo site (domínio registrável) do Atlas";
	return null;
}
