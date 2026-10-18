import type { ApiAuthKind, ApiGroup, ApiProposal } from "./api-connector.js";

const AUTH_KINDS: readonly ApiAuthKind[] = ["oauth2", "apiKey", "bearer", "none"];

function text(raw: unknown, max: number): string {
	return typeof raw === "string" ? raw.trim().slice(0, max) : "";
}

function count(raw: unknown): number {
	return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.min(100_000, Math.floor(raw))) : 0;
}

function httpsUrl(raw: unknown): string | null {
	try {
		const url = new URL(String(raw));
		return url.protocol === "https:" || url.hostname === "localhost" ? url.toString() : null;
	} catch {
		return null;
	}
}

/** Valida o que vem de checkpoint, banco ou SSE: nunca confiar no formato. */
export function parseApiProposal(raw: unknown): ApiProposal | null {
	if (!raw || typeof raw !== "object") return null;
	const row = raw as Record<string, unknown>;
	const specUrl = httpsUrl(row.specUrl);
	const baseUrl = httpsUrl(row.baseUrl);
	const name = text(row.name, 60);
	const domain = text(row.domain, 120);
	const authKind = AUTH_KINDS.find((kind) => kind === row.authKind);
	if (!specUrl || !baseUrl || !name || !domain || !authKind) return null;
	const groups: ApiGroup[] = [];
	for (const item of Array.isArray(row.groups) ? row.groups.slice(0, 200) : []) {
		if (!item || typeof item !== "object") continue;
		const group = item as Record<string, unknown>;
		const tag = text(group.tag, 60);
		if (tag) groups.push({ tag, total: count(group.total), read: count(group.read), write: count(group.write) });
	}
	const redirectUrl = row.redirectUrl === undefined ? null : httpsUrl(row.redirectUrl) ?? text(row.redirectUrl, 300);
	const authDetail = text(row.authDetail, 120);
	return {
		specUrl,
		name,
		domain,
		baseUrl,
		authKind,
		...(authDetail ? { authDetail } : {}),
		operationCount: count(row.operationCount),
		readCount: count(row.readCount),
		groups,
		...(redirectUrl ? { redirectUrl } : {}),
		...(row.crossHost === true ? { crossHost: true } : {}),
		...(row.foundByBot === true ? { foundByBot: true } : {}),
	};
}
