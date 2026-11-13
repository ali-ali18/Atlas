// Validação determinística da URL que o modelo manda para `web_extract` (auditoria F1, S3). Defesa em profundidade:
// a porta `Search` (F2) é quem bloqueia SSRF de verdade (DNS, redirecionamento); aqui o modelo já não consegue nem
// pedir `file:`, `localhost`, IP privado ou o endereço de metadata da nuvem. Parse com `URL`, sem regex sobre texto livre.

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"] as const;

function ipv4Octets(host: string): number[] | null {
	const parts = host.split(".");
	if (parts.length !== 4) return null;
	const octets = parts.map((part) => (part.length > 0 && part.length <= 3 && [...part].every((c) => c >= "0" && c <= "9") ? Number(part) : Number.NaN));
	return octets.every((n) => n >= 0 && n <= 255) ? octets : null;
}

function isPrivateIpv4([a, b, c]: number[]): boolean {
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b! >= 64 && b! <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b! >= 16 && b! <= 31) ||
		(a === 192 && b === 0 && c === 0) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a! >= 224
	);
}

/** IPv6 já normalizado pelo `URL` (minúsculo, sem colchetes). Só endereço global (2000::/3) fora da faixa de documentação. */
function isPublicIpv6(host: string): boolean {
	const first = host.split(":")[0] ?? "";
	if (first.length === 0) return false; // "::", "::1", "::ffff:…" (mapeado para IPv4) e afins
	const head = Number.parseInt(first, 16);
	if (!Number.isFinite(head) || head < 0x2000 || head > 0x3fff) return false;
	return !host.startsWith("2001:db8:") && !host.startsWith("2001:0:") && !host.startsWith("2002:");
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Só http(s) para um host público: sem usuário/senha, sem nome local, sem IP privado, loopback, link-local ou metadata. */
export function checkPublicHttpUrl(raw: string): UrlCheck {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, reason: "not a valid URL" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "only http and https URLs are allowed" };
	if (url.username !== "" || url.password !== "") return { ok: false, reason: "URLs with credentials are not allowed" };
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (host.length === 0) return { ok: false, reason: "URL has no host" };
	if (host.startsWith("[")) {
		return isPublicIpv6(host.slice(1, -1)) ? { ok: true, url } : { ok: false, reason: "private, loopback or reserved IP addresses are not allowed" };
	}
	const octets = ipv4Octets(host);
	if (octets) return isPrivateIpv4(octets) ? { ok: false, reason: "private, loopback or reserved IP addresses are not allowed" } : { ok: true, url };
	if (host === "localhost" || !host.includes(".") || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
		return { ok: false, reason: "local and internal host names are not allowed" };
	}
	return { ok: true, url };
}
