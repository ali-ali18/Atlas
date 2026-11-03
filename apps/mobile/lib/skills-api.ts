// Habilidades que o `/` oferece: os mesmos endpoints do web (`useAddMenuSkills` em `chat-add-menu.tsx`): as do usuário
// (`GET /v1/skills`, só ativas e ligadas) e as de fábrica (`GET /v1/skills/builtin`). Sempre por `apiFetch`; o servidor
// só devolve as do dono da sessão.
import { ChatApiError, isUnauthorized } from "./chat-api";
import type { ApiFetch } from "./home-sync";

export type ComposerSkill = { id: string; /** Slug: o que `/habilidade` carrega. */ name: string; description: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function list(body: unknown): Record<string, unknown>[] {
	return isRecord(body) && Array.isArray(body.skills) ? body.skills.filter(isRecord) : [];
}

/** Junta as habilidades do usuário (ativas e ligadas, o slug é o nome) e as de fábrica (o slug próprio), sem repetir slug e só com slug válido. */
export function parseSkills(mine: unknown, builtin: unknown): ComposerSkill[] {
	const seen = new Set<string>();
	const out: ComposerSkill[] = [];
	const push = (id: unknown, slug: unknown, description: unknown) => {
		if (typeof id !== "string" || typeof slug !== "string" || !SLUG.test(slug) || seen.has(slug)) return;
		seen.add(slug);
		out.push({ id, name: slug, description: typeof description === "string" ? description : "" });
	};
	for (const skill of list(mine)) if (skill.enabled === true && skill.status === "active") push(skill.id, skill.name, skill.description);
	for (const skill of list(builtin)) push(`builtin:${String(skill.slug)}`, skill.slug, skill.description);
	return out;
}

async function read(apiFetch: ApiFetch, path: string): Promise<unknown> {
	const response = await apiFetch(path, { headers: { accept: "application/json" } });
	if (!response.ok) throw new ChatApiError(response.statusText || `HTTP ${response.status}`, response.status);
	return response.json();
}

/**
 * As duas listas. Sessão recusada (401) em qualquer uma sobe o erro (quem chamou encerra a sessão). Uma lista que falha
 * não derruba a outra (como no web), mas o resultado volta com `complete: false` para não ser guardado como definitivo; as
 * duas falhando lança.
 */
export async function fetchSkills(apiFetch: ApiFetch): Promise<{ skills: ComposerSkill[]; complete: boolean }> {
	const [mine, builtin] = await Promise.allSettled([read(apiFetch, "/v1/skills"), read(apiFetch, "/v1/skills/builtin")]);
	for (const result of [mine, builtin]) if (result.status === "rejected" && isUnauthorized(result.reason)) throw result.reason;
	if (mine.status === "rejected" && builtin.status === "rejected") throw mine.reason;
	return {
		skills: parseSkills(mine.status === "fulfilled" ? mine.value : null, builtin.status === "fulfilled" ? builtin.value : null),
		complete: mine.status === "fulfilled" && builtin.status === "fulfilled",
	};
}
