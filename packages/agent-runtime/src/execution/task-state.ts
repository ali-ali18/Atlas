import {
	createTaskState,
	MAX_TASK_ARTIFACTS,
	MAX_TASK_BLOCKERS,
	MAX_TASK_CRITERIA,
	MAX_TASK_OBJECTIVE_CHARS,
	parseTaskState,
	unmetCriteria,
	type TaskArtifact,
	type TaskLedger,
	type TaskListItem,
	type TaskCriterion,
	type TaskPhase,
	type TaskState,
} from "@workspace/shared";

export const FILE_CRITERION_ID = "artifact:file";

/** Pedido ao modelo (neutro) quando a resposta promete um arquivo que não existe. */
export const MISSING_ARTIFACT_NOTE =
	"The user asked for a file, but no file has been created in this run. Create it now with the file tool, or tell the user plainly that no file was produced and why. Do not claim a file exists unless a tool confirmed it.";

/** Pedido ao modelo (neutro) quando a resposta foi cortada pelo limite de saída. */
export const TRUNCATED_REPLY_NOTE =
	"Your previous reply was cut off by the output limit. Continue from where it stopped and finish concisely. If the content belongs in a file, create it with the file tool instead of writing it all in chat.";

/** Pedido ao modelo (neutro) quando a resposta veio sem texto e sem tool. */
export const EMPTY_REPLY_NOTE =
	"Your previous reply was empty: no text and no tool call. Continue the user's current task now: call the tool you need, or write the final answer. If you cannot finish, say plainly what is done, what is missing and the next step.";

/** Mensagem ao usuário (pt-BR) se o modelo segue sem responder depois da nova tentativa e do resumo final. */
export const EMPTY_REPLY_FALLBACK_TEXT =
	"O modelo não devolveu uma resposta para este pedido, mesmo após uma nova tentativa. O que foi feito até aqui está salvo na conversa; envie o pedido de novo ou reformule.";

/**
 * Rascunho refeito (`assistant_discard`): o usuário VIU o rascunho (fica no chat como "Rascunho revisado", recolhido).
 * O aviso diz isso com verdade e pede a resposta final corrigida, completa, sem repetir nem pedir desculpas pelo rascunho.
 */
export const WITHDRAWN_REPLY_NOTE =
	"Your previous reply was shown to the user as a draft (it stays visible, collapsed as a revised draft). Write the corrected final answer: complete and self-contained, keeping what was right and fixing what this note points out. Do not mention the draft or apologize for it.";
/** Revisões da resposta final por run, somando todos os portões (itens, créditos, arquivo): no máximo uma. */
export const MAX_ANSWER_REVISIONS_PER_RUN = 1;
export const withWithdrawnReply = (note: string) => `${note} ${WITHDRAWN_REPLY_NOTE}`;

export type TaskTracker =ReturnType<typeof createTaskTracker>;

/**
 * Mantém o TaskState do run. Critérios só entram por sinal determinístico
 * (ex.: o modelo prometeu um arquivo e a tool de criação existe); sucesso vem
 * de evidência estruturada (evento de arquivo), nunca de texto.
 */
export function createTaskTracker(initial: unknown, objective: string) {
	const state: TaskState = parseTaskState(initial) ?? createTaskState(objective);

	return {
		snapshot(): TaskState {
			return structuredClone(state);
		},
		/**
		 * Estado que vai para o checkpoint. Checklist herdado que o run nunca adotou
		 * (carry offered/asked) não é regravado: re-salvá-lo o manteria vivo para sempre
		 * e o run seguinte o ofereceria de novo. Adotado (set/update) ou criado aqui, persiste.
		 */
		persistable(): TaskState {
			const copy = structuredClone(state);
			if (copy.ledger?.carry === "offered" || copy.ledger?.carry === "asked") delete copy.ledger;
			return copy;
		},
		reviseObjective(text: string) {
			const next = text.trim().slice(0, MAX_TASK_OBJECTIVE_CHARS);
			if (!next || next === state.objective.text) return;
			state.objective = { text: next, version: state.objective.version + 1 };
		},
		setPhase(phase: TaskPhase) {
			state.phase = phase;
		},
		addBlocker(text: string) {
			state.blockers = [...state.blockers, text.slice(0, 200)].slice(-MAX_TASK_BLOCKERS);
		},
		recordArtifact(artifact: TaskArtifact) {
			state.artifacts = [
				...state.artifacts.filter((item) => item.ref !== artifact.ref),
				artifact,
			].slice(-MAX_TASK_ARTIFACTS);
			if (artifact.kind === "file") {
				for (const criterion of state.criteria) {
					if (criterion.id === FILE_CRITERION_ID && criterion.status === "open") {
						criterion.status = "met";
						criterion.metBy = artifact.ref;
					}
				}
			}
		},
		/** Ledger de itens (V3): opcional; `undefined` remove. */
		ledger(): TaskLedger | undefined {
			return state.ledger ? structuredClone(state.ledger) : undefined;
		},
		taskList(): TaskListItem[] | undefined {
			return state.taskList ? structuredClone(state.taskList) : undefined;
		},
		setTaskList(next: TaskListItem[] | undefined) {
			if (next && next.length > 0) state.taskList = next;
			else delete state.taskList;
		},
		setLedger(next: TaskLedger | undefined) {
			if (next) state.ledger = next;
			else delete state.ledger;
		},
		hasArtifact(kind: TaskArtifact["kind"]): boolean {
			return state.artifacts.some((item) => item.kind === kind);
		},
		/** Exige um arquivo antes de concluir (idempotente; já existindo, o critério nasce cumprido). */
		expectFile(description: string) {
			if (state.criteria.some((item) => item.id === FILE_CRITERION_ID)) return;
			if (state.criteria.length >= MAX_TASK_CRITERIA) return;
			const file = state.artifacts.find((item) => item.kind === "file");
			const criterion: TaskCriterion = {
				id: FILE_CRITERION_ID,
				kind: "artifact",
				description: description.slice(0, 300),
				status: file ? "met" : "open",
				...(file ? { metBy: file.ref } : {}),
			};
			state.criteria.push(criterion);
		},
		/** Resposta honesta ("nenhum arquivo foi produzido"): o critério cai e o bloqueio fica registrado. */
		waiveFile(reason: string) {
			state.criteria = state.criteria.filter((item) => item.id !== FILE_CRITERION_ID);
			state.blockers = [...state.blockers, reason.slice(0, 200)].slice(-MAX_TASK_BLOCKERS);
		},
		unmet(): TaskCriterion[] {
			return unmetCriteria(state);
		},
	};
}
