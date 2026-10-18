import type { LlmContentPart, LlmMessage } from "@workspace/llm";
import { normalizeRunInputMode, type ObjectiveRevision, type RunInputMode, type TriagedInputBurst } from "@workspace/shared";
import type { MessageTriage } from "./message-triage.js";
import { appendAssistantAck, appendUserJoin, hasOpenToolBatch } from "./transcript.js";

/**
 * Consumo das entradas do usuário com o run ativo, por modo (PLANO-RUN-V2 §6).
 * `join` (e `steer` legado) entra no próximo ponto seguro e é o AGENTE quem
 * decide o que significa (triagem em `message-triage.ts`): conversa, mudança/
 * cancelamento ou pedido para depois. Os modos explícitos `redirect`/`interrupt`
 * revisam o objetivo, `queue` espera o próximo run e `cancel` encerra.
 */

export const JOIN_NOTE_HEADER = "[User note during the task]";
export const REDIRECT_NOTE_HEADER = "[Task changed by the user]";
/** Sem veredito da triagem: o modelo principal decide. */
export const USER_MESSAGE_HEADER = "[User message during the task]";
/** Revisões de objetivo por mensagem do usuário que a triagem pode abrir num run. */
export const MAX_TRIAGE_REVISIONS = 5;
export const TRIAGE_REVISION_REASON = "user_message";

export type PendingRunInput = {
	id: string;
	content: string;
	mode?: string;
	attachments?: Array<{ artifactId: string }>;
};

export type InputKind = "join" | "redirect";

const JOIN_NOTE_HINT = "Already answered. Keep working on the original task.";
const LATER_NOTE_HINT = "Already answered. The user wants this after the current task: keep working on the original task now.";
const REDIRECT_NOTE_HINT = "The user changed the task: follow this message as the new objective.";
const UNDECIDED_NOTE_HINT =
	"If it changes or cancels the task, follow it; otherwise reply briefly and continue the original task.";

export function formatInputNote(kind: InputKind, content: string): string {
	return kind === "redirect"
		? `${REDIRECT_NOTE_HEADER}\n${content}\n(${REDIRECT_NOTE_HINT})`
		: `${JOIN_NOTE_HEADER}\n${content}\n(${JOIN_NOTE_HINT})`;
}

/** Nota da mensagem `join` conforme o veredito; `null` (sem triagem) = cabeçalho neutro. */
export function formatTriagedNote(triage: MessageTriage | null, content: string): string {
	if (!triage) return `${USER_MESSAGE_HEADER}\n${content}\n(${UNDECIDED_NOTE_HINT})`;
	if (triage.kind === "change") return `${REDIRECT_NOTE_HEADER}\n${content}\n(${REDIRECT_NOTE_HINT} Already answered.)`;
	if (triage.kind === "later") return `${JOIN_NOTE_HEADER}\n${content}\n(${LATER_NOTE_HINT})`;
	return `${JOIN_NOTE_HEADER}\n${content}\n(${JOIN_NOTE_HINT})`;
}

/** Entrada para `objectiveRevisions[]` do checkpoint; `null` se o objetivo não mudou. */
export function buildObjectiveRevision(input: {
	before: { text: string; version: number };
	after: { text: string; version: number };
	reason: string;
	step?: number;
	now?: Date;
}): ObjectiveRevision | null {
	if (input.after.version === input.before.version) return null;
	return {
		previousText: input.before.text,
		newText: input.after.text,
		reason: input.reason,
		version: input.after.version,
		at: (input.now ?? new Date()).toISOString(),
		...(input.step !== undefined ? { atStep: input.step } : {}),
	};
}

export type IngestDeps = {
	/** Histórico atual do run (lido a cada chamada: a higiene pode substituí-lo). */
	conversation: () => LlmMessage[];
	consumed: Set<string>;
	/** Revisão versionada do objetivo (redirect/interrupt e `change` da triagem). */
	reviseObjective: (text: string, reason: string, revision?: { wantsFile?: boolean }) => void;
	onConsumed: (event: { inputId: string; mode: RunInputMode; content: string }) => Promise<void>;
	/**
	 * Triagem da rajada `join` (uma chamada por ingestão). `null` = sem veredito:
	 * entra o cabeçalho neutro e o modelo principal decide. Ausente = idem.
	 */
	triage?: (message: string) => Promise<MessageTriage | null>;
	/** Resposta da triagem como balão do assistente (depois de entrar no histórico). */
	onReply?: (text: string) => Promise<void> | void;
	/** `later`: guarda o pedido para encadear depois do run. Falhar não derruba o run. */
	queueFollowUp?: (instruction: string, key: string) => Promise<void>;
	/** `false` = limite de revisões por mensagem atingido: `change` vira cabeçalho neutro. */
	canRevise?: () => boolean;
	/**
	 * Rajadas já triadas durante uma tool longa (`live-triage.ts`): o balão e o
	 * `queueFollowUp` já saíram. Aqui só entram no histórico, sem triar de novo.
	 * Aplicadas são removidas do array.
	 */
	triaged?: TriagedInputBurst[];
};

export type IngestOutcome = {
	ingested: boolean;
	joined: number;
	redirected: number;
	/** Cancelamento pedido (modo `cancel` ou triagem com `cancel`): o chamador lança. */
	cancelled?: PendingRunInput;
};

function withImages(text: string, inputs: PendingRunInput[]): string | LlmContentPart[] {
	const refs: LlmContentPart[] = inputs
		.flatMap((item) => item.attachments ?? [])
		.slice(0, 4)
		.map((item) => ({ type: "image_ref" as const, artifactId: item.artifactId }));
	return refs.length ? [{ type: "text", text }, ...refs] : text;
}

/**
 * Texto de uma rajada de mensagens. Cada mensagem fica separada e numerada na ordem em que chegou: o modelo
 * vê que são várias falas novas do usuário (e a última pode corrigir ou reinterpretar a anterior), não um
 * parágrafo só.
 */
export function formatBurstText(items: ReadonlyArray<{ content: string }>): string {
	const texts = items.map((item) => item.content.trim()).filter(Boolean);
	if (texts.length <= 1) return texts[0] ?? "";
	return texts.map((text, index) => `Message ${index + 1} of ${texts.length}: ${text}`).join("\n");
}

/** Consome as entradas pendentes por modo, em ordem FIFO. */
export async function ingestRunInputs(pending: PendingRunInput[], deps: IngestDeps): Promise<IngestOutcome> {
	const outcome: IngestOutcome = { ingested: false, joined: 0, redirected: 0 };
	const burst: PendingRunInput[] = [];
	const preTriaged = new Map<TriagedInputBurst, PendingRunInput[]>();
	const groupOf = (id: string) => deps.triaged?.find((group) => group.ids.includes(id));
	for (const input of pending) {
		if (deps.consumed.has(input.id)) continue;
		const mode = normalizeRunInputMode(input.mode);
		if (mode === "cancel") {
			deps.consumed.add(input.id);
			await deps.onConsumed({ inputId: input.id, mode, content: input.content });
			outcome.cancelled = input;
			return outcome;
		}
		// queue fica pendente para o próximo run, não entra no loop atual.
		if (mode === "queue") continue;
		// Lote de tools aberto: fica pendente para a próxima fronteira (e mantém a ordem FIFO).
		if (hasOpenToolBatch(deps.conversation())) break;
		// join (e steer legado): o agente decide o significado, em rajada, depois do loop.
		if (mode === "join") {
			const group = groupOf(input.id);
			if (group) preTriaged.set(group, [...(preTriaged.get(group) ?? []), input]);
			else burst.push(input);
			continue;
		}
		const reason = mode === "interrupt" ? "user interrupted and redirected" : "user asked to redirect";
		const placed = appendUserJoin(deps.conversation(), withImages(formatInputNote("redirect", input.content), [input]));
		if (placed === "deferred") break;
		deps.reviseObjective(input.content, reason);
		outcome.redirected += 1;
		deps.consumed.add(input.id);
		outcome.ingested = true;
		await deps.onConsumed({ inputId: input.id, mode, content: input.content });
	}
	for (const [group, items] of preTriaged) {
		if (outcome.cancelled) break;
		await settleBurst(items, group.text, group.verdict, outcome, deps, true);
		// Adiado (lote aberto por corrida com a higiene): o grupo fica para o próximo ponto seguro.
		if (items.every((item) => deps.consumed.has(item.id)) && deps.triaged) {
			const at = deps.triaged.indexOf(group);
			if (at >= 0) deps.triaged.splice(at, 1);
		}
	}
	if (burst.length > 0 && !outcome.cancelled) await ingestBurst(burst, outcome, deps);
	return outcome;
}

async function triageBurst(text: string, deps: IngestDeps): Promise<MessageTriage | null> {
	if (!deps.triage || !text) return null;
	try {
		return await deps.triage(text);
	} catch {
		return null;
	}
}

/** Uma triagem por rajada de mensagens `join`; os efeitos seguem o veredito. */
async function ingestBurst(burst: PendingRunInput[], outcome: IngestOutcome, deps: IngestDeps): Promise<void> {
	const text = formatBurstText(burst);
	await settleBurst(burst, text, await triageBurst(text, deps), outcome, deps, false);
}

/**
 * Aplica o veredito da rajada. `early` = a triagem já rodou durante uma tool
 * longa: o balão e o follow-up `later` já saíram, só falta o histórico.
 */
async function settleBurst(
	burst: PendingRunInput[],
	text: string,
	triaged: MessageTriage | null,
	outcome: IngestOutcome,
	deps: IngestDeps,
	early: boolean,
): Promise<void> {
	let verdict = triaged;
	// Limite de revisões: além dele, o modelo principal decide sozinho (cancelar continua valendo).
	if (verdict?.kind === "change" && !verdict.cancel && deps.canRevise && !deps.canRevise()) verdict = null;

	const consumeAll = async () => {
		for (const item of burst) {
			deps.consumed.add(item.id);
			await deps.onConsumed({ inputId: item.id, mode: normalizeRunInputMode(item.mode), content: item.content });
		}
		outcome.ingested = true;
	};

	if (verdict?.cancel) {
		await consumeAll();
		if (!early) await deps.onReply?.(verdict.reply);
		outcome.cancelled = burst[0];
		return;
	}

	// Histórico pode ter mudado durante a triagem (higiene): appendUserJoin reconfere o lote aberto.
	const placed = appendUserJoin(deps.conversation(), withImages(formatTriagedNote(verdict, burst.length > 1 ? formatBurstText(burst) : text), burst));
	if (placed === "deferred") return;

	if (verdict) {
		appendAssistantAck(deps.conversation(), verdict.reply);
		if (!early) await deps.onReply?.(verdict.reply);
		if (verdict.kind === "change") {
			deps.reviseObjective(verdict.instruction, TRIAGE_REVISION_REASON, { wantsFile: verdict.wantsFile });
			outcome.redirected += 1;
		} else if (verdict.kind === "later" && !early) {
			try {
				await deps.queueFollowUp?.(verdict.instruction, `later:${burst[0]!.id}`);
			} catch {
				// A resposta já foi dada; o pedido segue só no checkpoint e o run não falha.
			}
		}
	}
	if (verdict?.kind !== "change") outcome.joined += burst.length;
	await consumeAll();
}
