import type { ComputerUseParams } from "@workspace/agent-runtime";
import type { Scenario, ScenarioConnector } from "../../scenario.js";
import type { RecordedToolCall, RecordedToolResult, Trajectory } from "../../trajectory.js";
import type { RequestCapture, ScriptTurn } from "./model.js";

export type V3Engine = "v2" | "v3";
export const V3_ENGINES: readonly V3Engine[] = ["v2", "v3"];

/** As 13 tarefas do desenho (11.1): cobertura completa do veredito. */
export const ALL_TASK_IDS: readonly string[] = Array.from({ length: 13 }, (_, index) => `T${index + 1}`);

/** Famílias de tarefa do critério "v3 >= v2 em toda tarefa e família" (desenho 11.3, item 2). */
export type TaskFamily = "conversa" | "automacao" | "seguranca" | "vm" | "longo";
export const TASK_FAMILIES: readonly TaskFamily[] = ["conversa", "automacao", "seguranca", "vm", "longo"];
export const FAMILY_LABEL: Record<TaskFamily, string> = { conversa: "conversa", automacao: "automação", seguranca: "segurança", vm: "navegador/VM", longo: "trabalho longo" };

/** Uma chamada de tool do run (nome real, já desembrulhado da ponte) junto com o resultado que o runtime devolveu. */
export type ToolOutcome = { call: RecordedToolCall; result: RecordedToolResult | undefined; ok: boolean };

export type CheckContext = {
	engine: V3Engine;
	/** `mock` = roteiro; `real` = modelo de verdade (checks de mecânica do roteiro não valem). */
	mode: "mock" | "real";
	task: V3Task;
	trajectory: Trajectory;
	captures: readonly RequestCapture[];
	text: string;
	/** Todas as chamadas, na ordem (inclui as recusadas: `ok` falso). */
	outcomes: readonly ToolOutcome[];
	/** Chamadas que o runtime executou (resultado `ok`) com o nome casando um dos padrões (`nome` ou `prefixo*`). */
	executed: (...patterns: string[]) => ToolOutcome[];
	/** Tentativas (executadas ou recusadas). */
	attempted: (...patterns: string[]) => ToolOutcome[];
	mainCalls: number;
	questions: number;
	/** Chamadas de resumo de compactação (modelo de manutenção, sem tools). */
	summaryCalls: number;
	files: Array<{ filename: string; content: string }>;
	fileCards: number;
};

/** Verificação determinística. Devolve `null` quando passa e o motivo quando falha. */
export type TaskCheck = {
	id: string;
	label: string;
	/**
	 * `safety` reprova o critério 1 do desenho (nunca é compensada); `completion` conta para a conclusão da tarefa;
	 * `metric` só é medida e mostrada no relatório (não entra na conclusão).
	 */
	kind: "safety" | "completion" | "metric";
	/**
	 * Motores em que a verificação vale (padrão: os dois). Check de um motor só NÃO entra na conclusão (não dá vitória nem
	 * derrota de graça na comparação): fica no relatório como observação desse motor.
	 */
	engines?: readonly V3Engine[];
	/** Só vale com o roteiro (mock): mede a mecânica que um modelo real não reproduz de forma determinística. */
	scripted?: boolean;
	run: (ctx: CheckContext) => string | null;
};

export type V3Task = {
	/** `T1` ... `T13` (desenho 11.1). */
	id: string;
	title: string;
	family: TaskFamily;
	/** O que o desenho manda verificar (texto da tabela 11.1). */
	verifies: string;
	scenario: Scenario;
	/** Roteiro do modelo por motor (só no mock: prova a mecânica, não o modelo). */
	turns: { v2: ScriptTurn[]; v3: ScriptTurn[] };
	checks: TaskCheck[];
	/** Tools que escrevem fora ou apagam (conector ou e-mail). Executada numa origem sem humano = escrita sem humano. */
	writeTools: string[];
	/** Tools que só uma injeção de prompt chamaria: executada = obediência à injeção. */
	injectionTools: string[];
	/** Origem sem humano: `writeTools` valem como violação. */
	unattended: boolean;
	/** Perfil do v2 (`long_work` na pesquisa longa); o v3 não tem perfil. */
	v2Profile?: "long_work";
	/** O run precisa da VM ligada (tools de navegador respondidas por fixture). */
	vm: boolean;
	/** Caixa de e-mail falsa ativa (tools de e-mail visíveis). */
	email: boolean;
	/** Parâmetros extras do runtime para esta tarefa (orçamento de contexto, conversa...). */
	overrides: { all?: Partial<ComputerUseParams>; v2?: Partial<ComputerUseParams>; v3?: Partial<ComputerUseParams> };
	/** O que a simulação desta tarefa NÃO cobre (vai para o relatório). */
	notCovered: string[];
	connectors: ScenarioConnector[];
};

export type { ScriptTurn };
