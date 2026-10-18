import { SKILL_INDEX_MAX_CHARS, SKILL_INDEX_MAX_ITEMS, buildSkillIndex, type SkillIndexEntry } from "@workspace/shared";
import { listSkillDocsForIndex } from "@workspace/db";
import { builtinSkillIndexText } from "@workspace/agent-runtime";

/**
 * Índice de skills do run (PLANO-SKILLS K1): skills ativas e habilitadas do dono
 * (conta + este bot; a do bot vence na colisão de nome), em texto determinístico
 * para o prefixo estável do prompt. Rascunho e skill desativada nunca entram
 * (filtro no db e de novo em `buildSkillIndex`). Falha de leitura não derruba o
 * run: segue sem índice (o agente ainda lê por `skill_read`).
 */
export type RunSkillIndexDeps = {
	list: (userId: string, botId?: string | null) => Promise<SkillIndexEntry[]>;
};

/**
 * Skills de fábrica primeiro (bloco constante, prefixo estável para o cache), as
 * do dono depois (variam por conta). Nome igual: a do dono vence e a de fábrica some.
 */
export function withBuiltinSkills(userIndex: string, entries: readonly SkillIndexEntry[]): string {
	const overridden = new Set(entries.filter((entry) => entry.enabled !== false && (entry.status ?? "active") === "active").map((entry) => entry.name));
	return [builtinSkillIndexText(overridden), userIndex].filter(Boolean).join("\n");
}

const defaultDeps: RunSkillIndexDeps = { list: listSkillDocsForIndex };

export async function loadRunSkillIndex(
	input: { userId: string; botId?: string | null },
	deps: RunSkillIndexDeps = defaultDeps,
): Promise<string> {
	try {
		const entries = await deps.list(input.userId, input.botId ?? null);
		const user = buildSkillIndex(entries, { maxItems: SKILL_INDEX_MAX_ITEMS, maxChars: SKILL_INDEX_MAX_CHARS });
		return withBuiltinSkills(user, entries);
	} catch (error) {
		console.error("skill index load failed; run continues without it", error instanceof Error ? error.message : "erro");
		return withBuiltinSkills("", []);
	}
}
