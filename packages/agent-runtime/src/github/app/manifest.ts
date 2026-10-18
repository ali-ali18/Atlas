/**
 * Manifest do GitHub App (fluxo "App Manifest"): o dono envia este JSON por um formulário
 * para github.com e volta com um `code` temporário que a API troca pelas credenciais.
 */
export const GITHUB_APP_PERMISSIONS = {
	contents: "write",
	pull_requests: "write",
	checks: "read",
	actions: "read",
	statuses: "read",
	// Escrever como o app (criar/editar issues, comentar, aplicar labels) exige issues:write.
	issues: "write",
	metadata: "read",
} as const;

/** Permissões que o app precisa ter para o bot escrever no GitHub com a identidade dele. */
export const GITHUB_APP_WRITE_PERMISSIONS = ["issues", "pull_requests", "contents"] as const;

const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** Permissões de escrita que o app instalado ainda não tem (o dono precisa aceitar a mudança no GitHub). */
export function missingGithubWritePermissions(granted: Record<string, string> | null | undefined): string[] {
	if (!granted) return [];
	return GITHUB_APP_WRITE_PERMISSIONS.filter((name) => (LEVEL[granted[name] ?? ""] ?? 0) < LEVEL.write!);
}

/** `installation` e `installation_repositories` o GitHub entrega sempre ao app (não entram em default_events). */
export const GITHUB_APP_EVENTS = [
	"push",
	"pull_request",
	"pull_request_review",
	"pull_request_review_comment",
	"issue_comment",
	"check_run",
	"check_suite",
	"workflow_run",
] as const;

export type GithubAppManifest = {
	name: string;
	url: string;
	hook_attributes: { url: string; active: boolean };
	redirect_url: string;
	callback_urls: string[];
	setup_url: string;
	setup_on_update: boolean;
	request_oauth_on_install: boolean;
	public: boolean;
	default_permissions: Record<string, string>;
	default_events: string[];
};

const trimSlash = (u: string): string => u.replace(/\/+$/, "");

export function githubAppUrls(input: { webUrl: string; publicUrl?: string }) {
	const web = trimSlash(input.webUrl);
	return {
		home: web,
		webhook: `${trimSlash(input.publicUrl || input.webUrl)}/v1/github-app/webhook`,
		manifestCallback: `${web}/v1/github-app/manifest/callback`,
		setup: `${web}/v1/github-app/setup`,
	};
}

export function buildGithubAppManifest(input: { name: string; webUrl: string; publicUrl?: string }): GithubAppManifest {
	const urls = githubAppUrls(input);
	return {
		name: input.name,
		url: urls.home,
		hook_attributes: { url: urls.webhook, active: true },
		redirect_url: urls.manifestCallback,
		callback_urls: [urls.setup],
		setup_url: urls.setup,
		setup_on_update: true,
		request_oauth_on_install: true,
		public: true,
		default_permissions: { ...GITHUB_APP_PERMISSIONS },
		default_events: [...GITHUB_APP_EVENTS],
	};
}

/** Nome do app (GitHub: até 34 caracteres, único globalmente). */
export function sanitizeGithubAppName(raw: unknown, fallback: string): string {
	const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
	const clean = Array.from(text)
		.filter((ch) => ch.charCodeAt(0) >= 32)
		.join("");
	return (clean || fallback).slice(0, 34).trim();
}

const ORG_PATTERN = new RegExp("^[A-Za-z0-9][A-Za-z0-9-]{0,38}$");

/** Destino do formulário: conta pessoal ou organização (`org` validado: letras, números e hífen). */
export function githubManifestTarget(org: unknown, state: string): string | null {
	const q = `?state=${encodeURIComponent(state)}`;
	if (org === undefined || org === null || org === "") return `https://github.com/settings/apps/new${q}`;
	if (typeof org !== "string" || !ORG_PATTERN.test(org)) return null;
	return `https://github.com/organizations/${org}/settings/apps/new${q}`;
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);

/** Página intermediária que envia o manifest ao GitHub (POST de formulário). */
export function renderManifestForm(input: { action: string; manifest: GithubAppManifest }): string {
	const manifestJson = escapeHtml(JSON.stringify(input.manifest));
	return [
		"<!doctype html>",
		'<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
		"<title>Indo para o GitHub</title>",
		"<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b0b0c;color:#e8e8ea}button{font:inherit;padding:.6rem 1rem;border-radius:.5rem;border:1px solid #444;background:#1c1c1f;color:inherit;cursor:pointer}</style>",
		"</head><body>",
		`<form id="f" method="post" action="${escapeHtml(input.action)}">`,
		`<input type="hidden" name="manifest" value="${manifestJson}">`,
		'<p>Abrindo o GitHub para criar o app…</p><noscript><button type="submit">Continuar no GitHub</button></noscript>',
		"</form>",
		'<script>document.getElementById("f").submit()</script>',
		"</body></html>",
	].join("");
}
