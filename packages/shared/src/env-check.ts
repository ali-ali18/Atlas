/**
 * Variáveis de ambiente esperadas, agrupadas por recurso. Variável ausente de um recurso opcional
 * não derruba nada, só desliga a função em silêncio, então api e worker listam isso no boot
 * (`formatMissingEnv`). Só nomes, nunca valores.
 */
import type { EnvLike } from "./build-info.js";

export type EnvGroup = {
	id: string;
	label: string;
	/** Efeito de faltar (uma linha, vai no log). */
	effect: string;
	vars: readonly string[];
	/** Quais serviços leem o grupo. */
	services: readonly ("api" | "worker")[];
	/** `true`: o serviço nem funciona sem (o próprio código já falha); `false`: só desliga o recurso. */
	core: boolean;
	/** Basta uma variável da lista para o recurso funcionar. */
	anyOf?: boolean;
};

export const ENV_GROUPS: readonly EnvGroup[] = [
	{ id: "core", label: "Base (banco, fila, auth)", effect: "o serviço não sobe ou não autentica", vars: ["DATABASE_URL", "REDIS_URL", "ATLAS_HOOK_PEPPER", "ATLAS_OWNER_EMAIL", "BETTER_AUTH_SECRET", "ATLAS_URL"], services: ["api", "worker"], core: true },
	{ id: "openrouter", label: "OpenRouter (modelos)", effect: "sem chave do servidor; vale só a chave própria de cada usuário (Configurações)", vars: ["OPENROUTER_API_KEY"], services: ["api", "worker"], core: false },
	{ id: "push", label: "Notificações push (Web Push/VAPID)", effect: "app funciona, mas não avisa no celular", vars: ["WEB_PUSH_PUBLIC_KEY", "WEB_PUSH_PRIVATE_KEY", "WEB_PUSH_SUBJECT"], services: ["api", "worker"], core: false },
	{ id: "connector-vault", label: "Cofre de conectores / Composio / webhook do GitHub", effect: "não salva chaves nem tokens de conectores (Composio, MCP) e o gatilho GitHub de rotinas fica desligado", vars: ["CONNECTOR_ENCRYPTION_KEY"], services: ["api", "worker"], core: false },
	{ id: "github-oauth", label: "GitHub OAuth (conector)", effect: "o GitHub conecta só por token pessoal (PAT) e o login com GitHub some", vars: ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"], services: ["api"], core: false },
	{ id: "google-oauth", label: "Google OAuth (login e conectores)", effect: "sem login com Google e sem conectores do Google", vars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"], services: ["api"], core: false },
	{ id: "slack-oauth", label: "Slack OAuth (conector)", effect: "o conector do Slack não conecta", vars: ["SLACK_OAUTH_CLIENT_ID", "SLACK_OAUTH_CLIENT_SECRET"], services: ["api"], core: false },
	{ id: "mail", label: "E-mail (magic link)", effect: "o link de login só é impresso no log (MAIL_URL=log://)", vars: ["MAIL_URL"], services: ["api", "worker"], core: false },
	{ id: "search", label: "Pesquisa web", effect: "web_search usa só o pipeline próprio (SearXNG)", vars: ["SEARCH_API_KEY", "FIRECRAWL_API_KEY"], services: ["api", "worker"], core: false, anyOf: true },
	{ id: "observability", label: "Observabilidade (Sentry)", effect: "erros não são enviados ao Sentry (o log segue normal)", vars: ["SENTRY_DSN"], services: ["api", "worker"], core: false },
] as const;

export type MissingEnvGroup = { group: EnvGroup; missing: string[] };

const present = (env: EnvLike, name: string): boolean => Boolean(env[name]?.trim());

/** Grupos do serviço com variável ausente (para `anyOf`, só quando NENHUMA está presente). */
export function missingEnvGroups(env: EnvLike, service: "api" | "worker"): MissingEnvGroup[] {
	const out: MissingEnvGroup[] = [];
	for (const group of ENV_GROUPS) {
		if (!group.services.includes(service)) continue;
		const missing = group.vars.filter((name) => !present(env, name));
		if (missing.length === 0) continue;
		if (group.anyOf && missing.length < group.vars.length) continue;
		out.push({ group, missing });
	}
	return out;
}

/** Linhas de log agrupadas por recurso; vazio quando está tudo configurado. */
export function formatMissingEnv(env: EnvLike, service: "api" | "worker"): string[] {
	return missingEnvGroups(env, service).map(({ group, missing }) => {
		const names = group.anyOf ? `${missing.join(" ou ")} (uma basta)` : missing.join(", ");
		return `[env] ${service}: ${group.label}${group.core ? " [ESSENCIAL]" : ""}: faltando ${names}. Efeito: ${group.effect}.`;
	});
}

/** Quais recursos estão configurados (sim/não), para o Diagnóstico. Nunca expõe valores. */
export function envGroupStatus(env: EnvLike): Array<{ id: string; label: string; configured: boolean; missing: string[] }> {
	return ENV_GROUPS.map((group) => {
		const missing = group.vars.filter((name) => !present(env, name));
		const configured = group.anyOf ? missing.length < group.vars.length : missing.length === 0;
		return { id: group.id, label: group.label, configured, missing: configured ? [] : missing };
	});
}
