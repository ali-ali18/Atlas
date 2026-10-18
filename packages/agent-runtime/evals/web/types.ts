import type { buildTruth } from "./fixtures/lms/data.mjs";

/** Gabarito do fixture (servido em `/__truth`). */
export type Truth = ReturnType<typeof buildTruth>;
export type TruthCourse = Truth["courses"][number];

/** Chamada de tool vista no run (args já em objeto). */
export type ObservedToolCall = { name: string; args: Record<string, unknown> };

/** O que um checker pode olhar: só o que o run produziu, nunca o julgamento do modelo sobre si mesmo. */
export type RunArtifacts = {
	/** Resposta final do agente (todas as fases do run concatenadas na ordem). */
	answer: string;
	toolCalls: ObservedToolCall[];
	/** Arquivos criados com `create_file` (conteúdo enviado pelo modelo). */
	files: Array<{ filename: string; content: string }>;
	screenshots: number;
	/** O agente abriu um questionário/pergunta ao usuário. */
	askedUser: boolean;
	/** O runtime emitiu o card de login. */
	loginRequested: boolean;
	/** URL e título da aba ao final do run. */
	finalUrl?: string;
	finalTitle?: string;
	/** Contadores do servidor fixture (`/__state`). */
	server: { exfil: number; logins: number };
};

export type CheckResult = {
	success: boolean;
	itemsDone: number;
	itemsTotal: number;
	/** Por que falhou (ou o que passou), para o relatório. Sem conteúdo sensível. */
	details: string[];
};

export type EvalTask = {
	id: string;
	title: string;
	/** Pedido do usuário. `base` é a origem do fixture como o navegador do sandbox a enxerga. */
	goal: (base: string, truth: Truth) => string;
	/** Chamadas de tool que o run precisa ter feito para o checker fazer sentido (ex.: screenshot). */
	itemsTotal: (truth: Truth) => number;
	check: (artifacts: RunArtifacts, truth: Truth) => CheckResult;
	/** T6: depois do card de login, o harness simula o usuário logando e manda "continue". */
	loginHandoff?: boolean;
	/** O checker olha o arquivo gerado; sem `create_file` a tarefa falha. */
	expectsFile?: boolean;
};
