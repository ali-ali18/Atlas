import type { runComputerUse } from "@workspace/agent-runtime";

/**
 * Variantes de harness para `--harness base,<outra>`: mesma bateria, mesmos modelos, uma troca no runtime. O delta
 * de acerto por cenário mostra se a troca ajuda ou atrapalha. `params` vai direto ao `runComputerUse`; `env` é
 * aplicado ao processo enquanto a variante roda (as variantes rodam uma depois da outra por isso). Variável lida só
 * ao carregar o módulo não muda entre variantes: para comparar commits, rode o runner em cada worktree e use
 * `compare <dirA> <dirB>`.
 */

export type HarnessVariant = {
	description: string;
	params?: Partial<Parameters<typeof runComputerUse>[0]>;
	env?: Record<string, string>;
};

export const HARNESS_VARIANTS: Record<string, HarnessVariant> = {
	base: { description: "como em produção (economia de contexto e disciplina de execução pelo padrão do ambiente)" },
	"sem-disciplina": { description: "sem a disciplina de execução (ledger, referências, estagnação, lote)", params: { executionDiscipline: false } },
	"com-disciplina": { description: "disciplina de execução forçada", params: { executionDiscipline: true } },
	"sem-economia": { description: "sem economia de contexto (todas as tools nativas no 1º passo)", params: { contextEconomy: false } },
};

export function resolveVariants(selector: string | undefined): Array<[string, HarnessVariant]> {
	const names = (selector ?? "base").split(",").map((name) => name.trim()).filter(Boolean);
	const unknown = names.filter((name) => !HARNESS_VARIANTS[name]);
	if (unknown.length > 0) throw new Error(`variante de harness desconhecida: ${unknown.join(", ")} (disponíveis: ${Object.keys(HARNESS_VARIANTS).join(", ")})`);
	return names.map((name) => [name, HARNESS_VARIANTS[name]!]);
}

/** Aplica o `env` da variante e devolve a função que restaura os valores anteriores. */
export function applyVariantEnv(variant: HarnessVariant, env: NodeJS.ProcessEnv = process.env): () => void {
	const previous = Object.entries(variant.env ?? {}).map(([key, value]) => {
		const before = env[key];
		env[key] = value;
		return [key, before] as const;
	});
	return () => {
		for (const [key, before] of previous) {
			if (before === undefined) delete env[key];
			else env[key] = before;
		}
	};
}
