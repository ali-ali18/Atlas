// Ajudantes (F3.1): `Helpers.runAll` roda o PRÓPRIO kernel (`runAgent`) uma vez por tarefa, em paralelo.
//
// Decisões:
//  - Preset filho: só as capacidades pedidas em `task.capabilities` que a MÃE também tem (o registro da mãe é a fonte).
//    Pedido de capacidade que a mãe não tem, ou que o filho nunca recebe (`research`/`delegate`: sem recursão), falha
//    SÓ aquela tarefa, com o motivo claro. A `web` do filho é reconstruída sobre a mesma porta `Search` da mãe, só que
//    embrulhada para registrar as páginas lidas (as fontes), sem depender de o modelo citá-las.
//  - Política filha: `childPolicy` (shared), pura. O filho só lê; nada de escrita, envio, dinheiro; mandato não herdado.
//  - Taint: o filho nasce com os sinais de proveniência da mãe (`motherProvenance`); `untrustedRead` do resultado é o que
//    o FILHO leu (eventos `tool_result` de tool declarada `untrusted`), não o que herdou. A volta para a mãe: ver taint.ts.
//  - Modelo: papel `helper` (a cadeia por papel é do adaptador `Llm`).
//  - Custo: livro compartilhado (`SpendLedger`). O gasto do filho entra no teto do dono da mãe, ao vivo; o filho para no
//    passo final honesto quando mãe + irmãos + ele passam do teto. Sem teto do dono, sem teto.
//  - Store: em memória, por ajudante (memory-store.ts). Nada vai ao banco do run da mãe nem a lease/checkpoint dela.
//  - Eventos: o sink do filho só observa (taint); nada vai ao SSE da mãe. Progresso resumido: a capacidade que chama
//    mostra o que quiser no resultado da própria tool.
//  - Concorrência: `HELPER_CONCURRENCY` é um limite TÉCNICO (rede, memória, taxa do provedor), nunca de economia.
import type { BotLanguage } from "@workspace/shared";
import { childPolicy } from "@workspace/shared";
import { createCapabilityRegistry, type Capability, type CapabilityRegistry } from "../capabilities/index.js";
import { redactDeep, type Hash, type PolicyContext } from "../contract/index.js";
import type { ChannelInput } from "../channels/envelope.js";
import { runAgent } from "../kernel/run.js";
import type { PriorProvenance, RunLimits, RunResult } from "../kernel/types.js";
import type { Clock } from "../ports/clock.js";
import type { Events, RunEvent } from "../ports/events.js";
import type { HelperResult, HelperTask, Helpers } from "../ports/helpers.js";
import type { Llm } from "../ports/llm.js";
import type { Ports } from "../ports/index.js";
import type { Queue } from "../ports/queue.js";
import type { Random } from "../ports/random.js";
import type { Sandbox } from "../ports/sandbox.js";
import type { Search } from "../ports/search.js";
import type { Vault } from "../ports/vault.js";
import { createWebCapability } from "../presets/web.js";
import { buildStablePrompt } from "../prompt/work-contract.js";
import { createMemoryStore } from "./memory-store.js";
import { HELPER_PROMPT, LEAD_TASK_LABEL } from "./prompt.js";
import { recordSources, type ExtractCache } from "./sources.js";
import type { SpendLedger } from "./spend-ledger.js";
import { inheritedProvenance } from "./taint.js";

/** Quantos ajudantes rodam ao mesmo tempo. Limite técnico (carga no provedor e na rede), não de custo: o resto espera a vez. */
export const HELPER_CONCURRENCY = 4;

/** Capacidades que o filho nunca recebe: um ajudante não cria ajudantes (sem recursão). */
export const HELPER_FORBIDDEN_CAPABILITIES: readonly string[] = ["research", "delegate"];

export type CreateHelpersDeps = {
	/** Run da mãe: o id dos filhos deriva dele; o dono é o mesmo (escopo de dados). */
	runId: string;
	ownerId: string;
	/** `Llm` dos filhos (o kernel pede o papel `helper`). O mesmo medidor da mãe, para o uso aparecer no run. */
	llm: Llm;
	clock: Clock;
	random: Random;
	hash: Hash;
	/** Registro da mãe, lido na hora de cada chamada (a mãe é montada depois dos ajudantes, porque a capacidade `research` os recebe). */
	motherRegistry: () => CapabilityRegistry;
	/** Política da mãe: a do filho deriva dela e nunca é maior. */
	motherPolicy: PolicyContext;
	/** Limites da mãe: o teto do dono (US$ e passos) vale para o filho também. */
	motherLimits: RunLimits;
	/** Sinais de proveniência da mãe agora (o filho herda). Sem ele, o filho começa limpo. */
	motherProvenance?: () => PriorProvenance | undefined;
	/** Livro de gasto compartilhado com o kernel da mãe (`ledger.motherHook()` no `runAgent` dela). */
	ledger: SpendLedger;
	/** Porta de busca da mãe: o `web` do filho a usa embrulhada, para registrar as fontes lidas. Sem ela, o `web` da mãe é reutilizado e o filho volta sem fontes. */
	search?: Search;
	language?: BotLanguage;
	concurrency?: number;
	/** Ids que o filho nunca recebe. Padrão: `HELPER_FORBIDDEN_CAPABILITIES`. */
	forbiddenCapabilities?: readonly string[];
};

const unavailable = (what: string) => new Error(`${what} is not available to a helper. Helpers only read.`);
const noQueue: Queue = {
	async enqueue() {
		throw unavailable("Scheduling");
	},
	async cancel() {
		return false;
	},
};
const noSandbox: Sandbox = {
	async run() {
		return { ok: false, error: "The computer is not available to a helper. Helpers only read." };
	},
	async release() {},
};
const noVault: Vault = {
	async listHandles() {
		return [];
	},
	async resolve() {
		return null;
	},
};

const failed = (error: string): HelperResult => ({ status: "failed", text: "", sources: [], spentUsd: 0, untrustedRead: false, error });
const stopped = (error: string): HelperResult => ({ status: "stopped", text: "", sources: [], spentUsd: 0, untrustedRead: false, error });

/** Registro do filho: as capacidades pedidas que a mãe tem. Devolve o motivo (claro) quando alguma não pode entrar. */
export function buildChildRegistry(input: { requested: readonly string[]; mother: CapabilityRegistry; forbidden: readonly string[]; web?: Search }): { ok: true; registry: CapabilityRegistry } | { ok: false; error: string } {
	const ids = [...new Set(input.requested)];
	const missing = ids.filter((id) => !input.mother.get(id));
	if (missing.length > 0) return { ok: false, error: `The lead agent does not have the capability ${missing.map((id) => `"${id}"`).join(", ")}, so a helper cannot use it. Available: ${input.mother.ids().join(", ") || "none"}.` };
	const barred = ids.filter((id) => input.forbidden.includes(id));
	if (barred.length > 0) return { ok: false, error: `Helpers cannot use ${barred.map((id) => `"${id}"`).join(", ")}: a helper does not start other helpers.` };
	const capabilities = ids.map((id) => (id === "web" && input.web ? createWebCapability(input.web) : (input.mother.get(id) as Capability)));
	return { ok: true, registry: createCapabilityRegistry(capabilities) };
}

/** Resultado do kernel → resultado do ajudante. O texto do modelo passa como está. */
export function helperStatusOf(result: RunResult): Pick<HelperResult, "status" | "error" | "partial"> {
	if (result.status === "done") return { status: "done" };
	if (result.status === "parked") return { status: "failed", error: "The helper reached an action that needs the owner. Helpers only read, so it was not run." };
	if (result.status === "failed") return result.reason === "cancelled" ? { status: "stopped", error: "cancelled" } : { status: "failed", error: result.error ?? result.reason ?? "the helper run failed" };
	// not_done: parou por um limite que protege o dono (ele diz qual) ou terminou com a última chamada de tool em erro.
	if (result.stop) return { status: "stopped", error: `stopped by ${result.stop.label}` };
	// Texto com chamada de tool ainda em erro: a resposta vale, mas é PARCIAL (a mãe não a trata como confirmada).
	if (result.text.trim().length > 0) return { status: "done", partial: true, error: `partial answer: the last tool call(s) failed (${Object.entries(result.unresolved).map(([name, why]) => `${name}: ${why}`).join("; ") || "unknown"})` };
	return { status: "failed", error: result.reason ?? `the helper ended without an answer (last tool errors: ${Object.keys(result.unresolved).join(", ") || "none"})` };
}

/**
 * Histórico do filho (S2). `objective` e `context` vêm do MODELO da mãe, que pode ter lido páginas: nenhum dos dois ganha a
 * autoridade de dono nem de sistema. O contexto é sempre DADO não confiável (`<data source="bot:lead" trust="untrusted">`,
 * com escape). O objetivo é rotulado como pedido da assistente principal, nunca como fala do dono; se a mãe já leu conteúdo
 * não confiável, ele também vira dado. O prompt do filho explica os dois rótulos.
 */
export function helperHistory(task: Pick<HelperTask, "objective" | "context">, motherReadUntrusted: boolean): ChannelInput[] {
	const context: ChannelInput[] = task.context ? [{ kind: "data", source: "bot:lead", text: `Context from the lead agent:\n${task.context}` }] : [];
	const objective: ChannelInput = motherReadUntrusted ? { kind: "data", source: "bot:lead", text: `Task from the lead agent:\n${task.objective}` } : { kind: "owner", text: `${LEAD_TASK_LABEL}\n${task.objective}` };
	return [...context, objective];
}

export function createHelpers(deps: CreateHelpersDeps): Helpers {
	const concurrency = Math.max(1, Math.floor(deps.concurrency ?? HELPER_CONCURRENCY));
	const forbidden = deps.forbiddenCapabilities ?? HELPER_FORBIDDEN_CAPABILITIES;
	let counter = 0;

	async function runOne(task: HelperTask, signal: AbortSignal | undefined, cache: ExtractCache): Promise<HelperResult> {
		if (signal?.aborted) return stopped("cancelled");
		const recorder = deps.search ? recordSources(deps.search, cache) : undefined;
		const built = buildChildRegistry({ requested: task.capabilities, mother: deps.motherRegistry(), forbidden, ...(recorder && { web: recorder.search }) });
		if (!built.ok) return failed(built.error);
		const { registry } = built;

		const cap = deps.motherLimits.ownerMaxUsd;
		if (cap !== undefined && cap > 0 && deps.ledger.totalUsd() >= cap) return stopped(`the spending limit the owner set (US$ ${cap.toFixed(2)}) was already reached before this helper started`);

		const index = ++counter;
		const key = `h${index}`;
		let untrustedRead = false;
		const events: Events = {
			emit(event: RunEvent) {
				// O filho só é observado: o taint do que ele leu sai daqui; nada vai ao SSE da mãe.
				if (event.type !== "tool_result") return;
				const data = event.data as { name?: unknown; status?: unknown } | undefined;
				if ((data?.status === "ok" || data?.status === "error") && typeof data.name === "string" && registry.toolByName(data.name)?.trust === "untrusted") untrustedRead = true;
			},
		};
		const ports: Ports = { llm: deps.llm, store: createMemoryStore(), queue: noQueue, sandbox: noSandbox, vault: noVault, clock: deps.clock, random: deps.random, events };
		const prior = inheritedProvenance(deps.motherProvenance?.());
		const policy = childPolicy(deps.motherPolicy);
		const { ownerMaxUsd, ownerMaxSteps, unattended, unattendedMaxSteps, safetyMaxSteps } = deps.motherLimits;
		// O filho herda o teto de passos da MÃE (o do dono; sem ele, a rede de segurança dela). Só entra no teto de run sem
		// dono quando a própria mãe está nele: o filho não tem dono presente (política), mas isso não corta pesquisa de chat.
		const limits: RunLimits = { ...(unattended && { unattended: true }), ...(ownerMaxUsd !== undefined && { ownerMaxUsd }), ...(ownerMaxSteps !== undefined && { ownerMaxSteps }), ...(unattendedMaxSteps !== undefined && { unattendedMaxSteps }), ...(safetyMaxSteps !== undefined && { safetyMaxSteps }) };

		try {
			const result = await runAgent({
				runId: `${deps.runId}:helper:${index}`,
				ownerId: deps.ownerId,
				input: {
					stableSystem: `${buildStablePrompt(registry, { workContract: false })}\n\n${HELPER_PROMPT}`,
					contextSections: [],
					history: helperHistory(task, prior?.untrustedReadInRun === true),
					...(prior && { priorProvenance: prior }),
				},
				ports,
				registry,
				policy,
				limits,
				hash: deps.hash,
				role: "helper",
				askOwner: false,
				spend: deps.ledger.childHook(key),
				...(signal && { signal }),
				...(deps.language && { language: deps.language }),
			});
			return { ...helperStatusOf(result), text: result.text, sources: recorder?.sources() ?? [], spentUsd: result.spentUsd, untrustedRead };
		} catch (error) {
			return failed(redactDeep(error instanceof Error ? error.message : String(error)));
		}
	}

	return {
		async runAll(tasks, signal) {
			const results = new Array<HelperResult>(tasks.length);
			// Uma leitura por URL neste lote (C3): os ajudantes do mesmo `runAll` dividem as páginas já extraídas.
			const cache: ExtractCache = new Map();
			let next = 0;
			// Fila com N trabalhadores: a ordem do resultado é a das tarefas, não a de término.
			const worker = async () => {
				for (let i = next++; i < tasks.length; i = next++) results[i] = await runOne(tasks[i] as HelperTask, signal, cache);
			};
			await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
			return results;
		},
	};
}
