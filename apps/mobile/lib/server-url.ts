export type ServerUrlResult = { ok: true; url: string } | { ok: false; error: string };

export type ServerUrlOptions = {
	/** Em desenvolvimento aceitamos `http` para localhost e rede local. Em produção, só `https`. */
	dev: boolean;
};

export const SERVER_URL_ERRORS = {
	empty: "Informe o endereço do servidor.",
	invalid: "Esse endereço não parece válido. Exemplo: https://atlas.suaempresa.com",
	protocol: "Use um endereço https.",
	insecure: "Por segurança, use um endereço https. Conexões http só funcionam em desenvolvimento, em localhost ou na rede local.",
	credentials: "Tire o usuário e a senha do endereço.",
} as const;

const PRIVATE_IPV4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./];

/** `localhost`, `127.x`, IP privado de LAN ou `*.local`: lugares onde http é aceitável em dev. */
export function isLocalHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
	if (host === "::1") return true;
	return PRIVATE_IPV4.some((pattern) => pattern.test(host));
}

function hostOf(raw: string): string {
	const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
	const authority = withoutScheme.split(/[/?#]/)[0] ?? "";
	const host = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
	return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "");
}

/**
 * Valida e normaliza o endereço do servidor digitado pelo usuário. Sem esquema, assume `https://`
 * (ou `http://` quando for localhost/LAN em dev). Devolve `origem + caminho` sem barra final,
 * sem query nem fragmento.
 */
export function normalizeServerUrl(input: string, options: ServerUrlOptions): ServerUrlResult {
	const raw = input.trim();
	if (!raw) return { ok: false, error: SERVER_URL_ERRORS.empty };
	if (/\s/.test(raw)) return { ok: false, error: SERVER_URL_ERRORS.invalid };

	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
	// "localhost:3000" parece ter esquema ("localhost:") mas é host:porta; por isso só `://` conta.
	const candidate = hasScheme ? raw : `${options.dev && isLocalHost(hostOf(raw)) ? "http" : "https"}://${raw}`;

	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		return { ok: false, error: SERVER_URL_ERRORS.invalid };
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, error: SERVER_URL_ERRORS.protocol };
	}
	if (!parsed.hostname) return { ok: false, error: SERVER_URL_ERRORS.invalid };
	if (parsed.username || parsed.password) return { ok: false, error: SERVER_URL_ERRORS.credentials };
	if (parsed.protocol === "http:" && !(options.dev && isLocalHost(parsed.hostname))) {
		return { ok: false, error: SERVER_URL_ERRORS.insecure };
	}
	// Host sem ponto e que não é local ("atlas") quase sempre é erro de digitação.
	if (!parsed.hostname.includes(".") && !parsed.hostname.includes(":") && !isLocalHost(parsed.hostname)) {
		return { ok: false, error: SERVER_URL_ERRORS.invalid };
	}

	const path = parsed.pathname.replace(/\/+$/, "");
	return { ok: true, url: `${parsed.protocol}//${parsed.host}${path}` };
}
