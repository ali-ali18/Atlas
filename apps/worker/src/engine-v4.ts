/**
 * Motor v4 no worker (PLANO-AGENTE-V4, F1.12). Só roda quando `chooseRunEngine` devolve `v4` (flag `ATLAS_ENGINE_V4` +
 * conta em `ATLAS_ENGINE_V4_ACCOUNTS`); com a flag desligada, que é o padrão, nada daqui é chamado.
 *
 * Monta as portas reais do `@workspace/agent` (adaptadores) com as dependências do worker injetadas e roda `runAgent`.
 * O contrato do worker não muda: lease, status, `run_events` e a conclusão atômica continuam no processador; aqui o
 * resultado do kernel vira o mesmo `{ text, model, hitWall, usage, stop }` que o v1/v2 devolvem.
 *
 * Caminho mínimo (o preset `minimal` e o mapeamento completo de eventos chegam com F1.14/`kernel/sse-map`):
 * - eventos: texto, chamada e resultado de tool viram eventos do contrato SSE; o resto não é gravado ainda;
 * - registro de capacidades vazio por padrão (resposta sem tools de ação), sandbox indisponível com erro honesto;
 * - run estacionado: devolve `parked: true` e o processador pausa o run (`paused`, motivo `awaiting_owner`). FOLLOW-UP:
 *   levar o clique do dono (`ResumeInput.grants`/`denied`) da API até `runAgent` na retomada; hoje a retomada só recarrega
 *   o checkpoint. Com a flag desligada (padrão) nada disso roda.
 * - FOLLOW-UP: trocar `createMinimalEventMapper` por `createSseMapper(...).mapRunEvent` (kernel/sse-map, parte A) quando
 *   as duas branches se juntarem; `mapEvent` já é injetável.
 */
import { createHash } from "node:crypto";
import {
	copyFor,
	createCapabilityRegistry,
	createEventsAdapter,
	createLlmAdapter,
	createQueueAdapter,
	createStoreAdapter,
	createSystemClock,
	createSystemRandom,
	createVaultAdapter,
	runAgent,
	type BullLikeQueue,
	type CapabilityRegistry,
	type ChannelInput,
	type Llm,
	type LlmChatRequest,
	type LlmRole,
	type LlmStreamEvent,
	type PolicyContext,
	type Ports,
	type RunEvent,
	type RunLimits,
	type RunResult,
	type Sandbox,
	type StoreBackend,
	type VaultBackend,
} from "@workspace/agent";
import type { ProviderStreamChat } from "@workspace/llm";
import {
	appendAgentJournalEntry,
	assertAgentV4Lease,
	appendAgentReceipt,
	findAgentJournalEntry,
	getAgentConversationState,
	getAgentNote,
	listAgentJournalEntries,
	listAgentNotes,
	listAgentReceipts,
	loadAgentV4Checkpoint,
	removeAgentNote,
	saveAgentConversationState,
	saveAgentNote,
	saveAgentV4Checkpoint,
	type RunLease,
} from "@workspace/db";
import { MODEL_ROLES, formatModelRef, isMaintenanceModel, parseModelRef, type BotLanguage, type ComputerUseEvent, type ModelChainEntry, type RoleChains, type RunStop, type RunUsage } from "@workspace/shared";

/** As funções de persistência do v4 (as de `@workspace/db`); injetáveis para o teste. */
export type V4Db = {
	saveCheckpoint: typeof saveAgentV4Checkpoint;
	loadCheckpoint: typeof loadAgentV4Checkpoint;
	appendJournal: typeof appendAgentJournalEntry;
	/** Opcional: o teste que não simula lease pode omitir. */
	assertLease?: typeof assertAgentV4Lease;
	findJournal: typeof findAgentJournalEntry;
	listJournal: typeof listAgentJournalEntries;
	appendReceipt: typeof appendAgentReceipt;
	listReceipts: typeof listAgentReceipts;
	saveNote: typeof saveAgentNote;
	getNote: typeof getAgentNote;
	listNotes: typeof listAgentNotes;
	removeNote: typeof removeAgentNote;
	getConversation: typeof getAgentConversationState;
	saveConversation: typeof saveAgentConversationState;
};

export const realV4Db: V4Db = {
	saveCheckpoint: saveAgentV4Checkpoint,
	loadCheckpoint: loadAgentV4Checkpoint,
	appendJournal: appendAgentJournalEntry,
	assertLease: assertAgentV4Lease,
	findJournal: findAgentJournalEntry,
	listJournal: listAgentJournalEntries,
	appendReceipt: appendAgentReceipt,
	listReceipts: listAgentReceipts,
	saveNote: saveAgentNote,
	getNote: getAgentNote,
	listNotes: listAgentNotes,
	removeNote: removeAgentNote,
	getConversation: getAgentConversationState,
	saveConversation: saveAgentConversationState,
};

/**
 * `StoreBackend` sobre o db. O checkpoint só grava com o lease desta execução (perdeu o lease = `lease_lost`, que o
 * processador já trata). `setStatus` não grava no banco: o status do run (conclusão, erro, cancelamento) é do processador,
 * pelo caminho atômico de sempre; gravar `done` aqui adiantaria a conclusão antes da mensagem final.
 */
export function storeBackendFromDb(db: V4Db, lease: Pick<RunLease, "owner" | "token"> | null): StoreBackend {
	return {
		saveCheckpoint: (userId, checkpoint) => db.saveCheckpoint(userId, checkpoint, lease),
		loadCheckpoint: (userId, runId) => db.loadCheckpoint(userId, runId),
		setStatus: async () => undefined,
		appendJournal: (entry) => db.appendJournal(entry),
		// Antes de cada efeito o executor confere o lease (S5); sem lease (teste) não há o que conferir.
		...(lease && db.assertLease && { assertLease: (userId: string, runId: string) => db.assertLease!(userId, runId, lease) }),
		findJournal: (userId, runId, key) => db.findJournal(userId, runId, key),
		listJournal: (userId, runId) => db.listJournal(userId, runId),
		appendReceipt: (receipt) => db.appendReceipt({ ...receipt, userId: receipt.userId }),
		listReceipts: (userId, runId) => db.listReceipts(userId, runId),
		saveNote: (note) => db.saveNote(note),
		getNote: async (userId, id) => {
			const note = await db.getNote(userId, id);
			return note && { id: note.id, userId: note.userId, title: note.title, body: note.body, pinned: note.pinned };
		},
		listNotes: async (userId) => (await db.listNotes(userId)).map((n) => ({ id: n.id, userId: n.userId, title: n.title, body: n.body, pinned: n.pinned })),
		removeNote: (userId, id) => db.removeNote(userId, id),
		getConversation: (userId, conversationId) => db.getConversation(userId, conversationId),
		saveConversation: (userId, conversationId, state) => db.saveConversation(userId, conversationId, state),
	};
}

/** Cofre: só segredos simples (`kind: "secret"`); o id do handle é o nome do item, que é o que o serviço resolve. */
export type VaultServiceLike = {
	listMeta(userId: string): Promise<Array<{ kind: string; name: string; label: string }>>;
	resolveRef(userId: string, ref: { kind: "secret"; name: string; raw: string }, by?: { actor?: "user" | "bot"; detail?: string }): Promise<{ value: string } | null>;
};

export function vaultBackendFromService(service: VaultServiceLike): VaultBackend {
	return {
		async listHandles(userId) {
			return (await service.listMeta(userId)).filter((m) => m.kind === "secret").map((m) => ({ id: m.name, label: m.label || m.name }));
		},
		async resolveSecret(userId, handleId) {
			const resolved = await service.resolveRef(userId, { kind: "secret", name: handleId, raw: handleId }, { actor: "bot", detail: "agent_v4" });
			return resolved?.value ?? null;
		},
	};
}

/** Sem adaptador de VM no v4 ainda: a tool que pedir recebe o motivo real (resultado honesto), o run segue. */
export const unavailableSandbox: Sandbox = {
	async run() {
		return { ok: false, error: "The computer (virtual machine and browser) is not available in this version. Tell the owner plainly, and offer an alternative that does not need it." };
	},
	async release() {
		return undefined;
	},
};

/** Fila indisponível (flag ligada sem a fila criada): enfileirar falha com o motivo, nunca em silêncio. */
export const unavailableQueue: BullLikeQueue = {
	async add() {
		throw new Error("Scheduling is not available right now. Tell the owner plainly that you cannot schedule this, and offer an alternative.");
	},
	async getJob() {
		return null;
	},
};

/**
 * Contrato de eventos MÍNIMO: o kernel emite, o contrato SSE entende. O mapa completo (cartões, status, etc.) é do
 * `kernel/sse-map` do pacote; quando ele existir, `mapEvent` o recebe no lugar deste. Evento desconhecido não é gravado.
 */
export function createMinimalEventMapper(runId: string): (event: RunEvent) => ComputerUseEvent[] {
	let step = 0;
	return (event) => {
		const data = (event.data ?? {}) as Record<string, unknown>;
		switch (event.type) {
			case "step":
				step = typeof data.step === "number" ? data.step : step + 1;
				return [];
			case "text_delta":
				return typeof data.text === "string" && data.text ? [{ type: "assistant_delta", id: `${runId}:${step}`, delta: data.text }] : [];
			case "tool_call":
				return [{ type: "tool_call", id: String(data.callId), name: String(data.name), args: JSON.stringify(data.args ?? {}), step }];
			case "tool_result":
				return [{ type: "tool_result", id: String(data.callId), name: String(data.name), ok: data.status === "ok", summary: String(data.content ?? "").slice(0, 300) }];
			default:
				return [];
		}
	};
}

/** Soma o uso do modelo por chamada (o kernel só devolve o gasto em US$) e guarda o modelo que respondeu por último. */
export function meterLlm(llm: Llm): { llm: Llm; usage: () => RunUsage; model: () => string } {
	let prompt = 0;
	let completion = 0;
	let cached = 0;
	let cost = 0;
	let unknown = 0;
	let model = "";
	const metered: Llm = {
		contextWindow: (role: LlmRole) => llm.contextWindow(role),
		async *chat(request: LlmChatRequest): AsyncIterable<LlmStreamEvent> {
			for await (const event of llm.chat(request)) {
				if (event.type === "done") {
					prompt += event.usage.inputTokens;
					completion += event.usage.outputTokens;
					cached += event.usage.cachedInputTokens ?? 0;
					if (event.usage.costUsd === undefined) unknown += 1;
					else cost += event.usage.costUsd;
					model = `${event.served.provider}/${event.served.model}`;
				}
				yield event;
			}
		},
	};
	return {
		llm: metered,
		usage: () => ({ promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, ...(cached > 0 && { cachedTokens: cached }), costUsd: cost, ...(unknown > 0 && { costUnknownCalls: unknown }) }),
		model: () => model,
	};
}

/**
 * Modelo barato dos papéis auxiliares (`helper`, `sleep`, `classifier`). Decisão do dono: Haiku. É um padrão de
 * configuração, não conta fixa: `ATLAS_V4_CHEAP_MODEL` troca, e `roleModels` (por papel) manda sobre os dois.
 */
export const V4_CHEAP_MODEL_DEFAULT = "anthropic/claude-haiku-5.5";
// `ModelRole` do índice do shared é outro tipo (papéis do subagente); o dos papéis do Llm vem de MODEL_ROLES.
type ModelRole = (typeof MODEL_ROLES)[number];
export const V4_CHEAP_ROLES = ["helper", "sleep", "classifier"] as const satisfies readonly ModelRole[];

/** Modelo barato do deploy: a variável vale se for um modelo de manutenção válido (nunca `chatgpt/*`, que é a assinatura do dono). */
export function cheapModelFromEnv(env: Record<string, string | undefined> = process.env): string {
	const configured = env.ATLAS_V4_CHEAP_MODEL?.trim();
	return configured && isMaintenanceModel(configured) ? configured : V4_CHEAP_MODEL_DEFAULT;
}

function chainEntry(model: string): ModelChainEntry | null {
	try {
		const ref = parseModelRef(model);
		return { provider: ref.provider, model: ref.slug };
	} catch {
		return null;
	}
}

/**
 * Cadeias por papel do v4. `main` é o modelo do run. Os papéis baratos começam pelo modelo barato (ou pelo que
 * `roleModels` define) e SÓ caem no modelo principal se o barato não estiver disponível (sem chave, fora do ar):
 * compactar com o modelo principal custava caro sem necessidade. Papel sem configuração própria (`code`, `vision`)
 * usa o principal. Ref inválida em `roleModels` é ignorada (cai no padrão do papel), nunca derruba o run.
 */
export function buildV4RoleChains(input: { model: string; cheapModel?: string; roleModels?: Partial<Record<ModelRole, string>> }): RoleChains {
	const main = chainEntry(input.model) as ModelChainEntry;
	const sameAs = (a: ModelChainEntry, b: ModelChainEntry) => a.provider === b.provider && a.model === b.model;
	const chains = {} as RoleChains;
	for (const role of MODEL_ROLES) {
		const isCheap = (V4_CHEAP_ROLES as readonly ModelRole[]).includes(role);
		const configured = input.roleModels?.[role];
		const preferred = (configured ? chainEntry(configured) : null) ?? (isCheap ? chainEntry(input.cheapModel ?? V4_CHEAP_MODEL_DEFAULT) : null);
		chains[role] = preferred && !sameAs(preferred, main) ? [preferred, main] : [main];
	}
	return chains;
}

/**
 * `Llm` do v4 sobre o roteador do worker (`providers.streamChat`, que já resolve chaves e reserva por provedor).
 * Cadeias por papel: ver `buildV4RoleChains`. Tetos de gasto por período (dia/semana/mês) da conta ou do bot ainda não
 * existem na configuração do worker; só o teto POR EXECUÇÃO do dono (`limits.ownerMaxUsd`) vale. Quando existirem,
 * entram em `ceilings`/`spend` do adaptador (já suportados lá).
 */
export function createV4Llm(input: {
	model: string;
	streamChat: ProviderStreamChat;
	openRouterKey: string;
	contextWindow?: (model: string) => Promise<number | null>;
	/** Idioma do bot: os avisos do adaptador ao dono saem nele. */
	language?: unknown;
	cheapModel?: string;
	roleModels?: Partial<Record<ModelRole, string>>;
}): Llm {
	const chains = buildV4RoleChains({ model: input.model, ...(input.cheapModel && { cheapModel: input.cheapModel }), ...(input.roleModels && { roleModels: input.roleModels }) });
	return createLlmAdapter({
		streamChat: input.streamChat,
		chains,
		// OpenRouter usa a chave do worker; os provedores diretos resolvem a chave do dono dentro do `streamChat`.
		apiKeyFor: (provider) => (provider === "openrouter" ? input.openRouterKey || undefined : "provider-managed"),
		clock: createSystemClock(),
		...(input.language !== undefined && { language: input.language }),
		// Janela do modelo da ENTRADA escolhida (o auxiliar tem janela própria). Consulta sem resposta lança: o adaptador
		// então mantém a última janela conhecida em vez de cair para 128k.
		...(input.contextWindow && {
			contextWindowFor: async (entry: ModelChainEntry) => {
				const window = await input.contextWindow!(formatModelRef(entry.provider, entry.model));
				if (window == null) throw new Error("context window unknown");
				return window;
			},
		}),
	});
}

/** Eventos de SSE que o PROCESSADOR emite uma vez ao fechar o run (conclusão atômica, erro, cancelamento, teto de passos). */
const processorOwned = (event: ComputerUseEvent): boolean =>
	event.type === "done" || event.type === "error" || event.type === "cancelled" || (event.type === "status" && event.status === "budget_exhausted" && event.stopReason === "budget_steps");

/**
 * O `final` e os status terminais do kernel viram `done`/`error`/`cancelled` no mapa de SSE, mas quem fecha o stream
 * do run é o processador (um `done`, um `error` ou um `cancelled`, e a nota de teto de passos). Sem este filtro cada
 * fim aparecia duas vezes. Fica o aviso de teto de GASTO, que o processador não emite.
 */
export function dropProcessorOwnedEvents(map: (event: RunEvent) => readonly ComputerUseEvent[]): (event: RunEvent) => ComputerUseEvent[] {
	return (event) => map(event).filter((mapped) => !processorOwned(mapped));
}

/** Teto de passos do DONO para o kernel: só vale quando veio de configuração (tem origem); o de segurança é do kernel. */
export function ownerStepsLimit(stepsCap: { steps: number; stepsSource?: unknown }): number | undefined {
	return stepsCap.stepsSource ? stepsCap.steps : undefined;
}

export type V4EngineResult = { text: string; model: string; hitWall: boolean; usage: RunUsage; stop: RunStop; parked: boolean };

export type RunEngineV4Input = {
	runId: string;
	userId: string;
	conversationId?: string | null;
	/** Texto do dono neste turno (o objetivo do run). */
	objective: string;
	history?: readonly ChannelInput[];
	contextSections?: readonly string[];
	language?: BotLanguage;
	llm: Llm;
	/** Lease desta execução; o checkpoint só grava enquanto ele vale. */
	lease: Pick<RunLease, "owner" | "token"> | null;
	/** Grava um evento do contrato SSE (o processador liga ao coalescedor/`appendRunEvent`, como no v2). */
	persistEvent: (event: ComputerUseEvent) => void | Promise<void>;
	limits: RunLimits;
	ownerPresent: boolean;
	signal?: AbortSignal;
	db?: V4Db;
	queue?: BullLikeQueue;
	vault?: VaultBackend;
	sandbox?: Sandbox;
	registry?: CapabilityRegistry;
	/** Prompt estável do preset (sem ele, o kernel monta o completo com o contrato de trabalho). */
	stableSystem?: string;
	policy?: PolicyContext;
	mapEvent?: (event: RunEvent) => readonly ComputerUseEvent[];
};

const sha256 = (payload: string): string => createHash("sha256").update(payload).digest("hex");

function stopOf(result: RunResult): { stop: RunStop; hitWall: boolean } {
	const kind = result.stop?.kind;
	if (kind === "steps_owner" || kind === "steps_unattended" || kind === "steps_safety") return { stop: { reason: "budget_steps" }, hitWall: true };
	if (kind === "cost") return { stop: { reason: "budget_cost" }, hitWall: false };
	if (kind === "repeated") return { stop: { reason: "loop_repeat" }, hitWall: false };
	if (result.awaiting) return { stop: { reason: "awaiting_confirmation", detail: "ask_owner" }, hitWall: false };
	return { stop: { reason: "answered" }, hitWall: false };
}

/** Máximo de recibos citados na nota de parada (o resto fica no cartão de cada recibo, já emitido ao vivo). */
const STOPPED_LIST_MAX = 8;

/** Texto "o que já foi feito" para a nota de parada; vazio quando nenhum efeito foi consumado. Função pura. */
export function stoppedEffectsNote(receipts: ReadonlyArray<{ summary: string }>, language?: unknown): string {
	const done = receipts.map((r) => r.summary.trim()).filter(Boolean);
	if (done.length === 0) return "";
	const shown = done.slice(0, STOPPED_LIST_MAX).join("; ");
	return copyFor(language, "stopped_with_effects", { list: done.length > STOPPED_LIST_MAX ? `${shown}; +${done.length - STOPPED_LIST_MAX}` : shown });
}

/** Melhor esforço: falhar ao listar os recibos nunca atrapalha o cancelamento. */
async function announceStoppedEffects(ports: Ports, input: RunEngineV4Input): Promise<void> {
	try {
		const detail = stoppedEffectsNote(await ports.store.receipts.listForRun(input.userId, input.runId), input.language);
		if (detail) await input.persistEvent({ type: "status", status: "stopped_with_effects", detail, stopReason: "cancelled" });
	} catch {
		// sem a nota, o `cancelled` do processador ainda fecha o run
	}
}

export async function runEngineV4(input: RunEngineV4Input): Promise<V4EngineResult> {
	const meter = meterLlm(input.llm);
	const ports: Ports = {
		llm: meter.llm,
		store: createStoreAdapter(storeBackendFromDb(input.db ?? realV4Db, input.lease)),
		queue: createQueueAdapter(input.queue ?? unavailableQueue),
		sandbox: input.sandbox ?? unavailableSandbox,
		vault: createVaultAdapter(input.vault ?? { listHandles: async () => [], resolveSecret: async () => null }),
		clock: createSystemClock(),
		random: createSystemRandom(),
		events: createEventsAdapter({ runId: input.runId, userId: input.userId, map: input.mapEvent ?? createMinimalEventMapper(input.runId), persist: input.persistEvent }),
	};
	const result = await runAgent({
		runId: input.runId,
		ownerId: input.userId,
		input: {
			...(input.stableSystem && { stableSystem: input.stableSystem }),
			contextSections: input.contextSections ?? [],
			history: input.history ?? [{ kind: "owner", text: input.objective }],
			...(input.conversationId && { conversationId: input.conversationId }),
		},
		ports,
		registry: input.registry ?? createCapabilityRegistry([]),
		policy: input.policy ?? { surface: "chat", ownerPresent: input.ownerPresent, autonomy: "balanced", rules: [] },
		limits: input.limits,
		hash: sha256,
		...(input.signal && { signal: input.signal }),
		...(input.language && { language: input.language }),
	});
	// "Parar" no meio do run: parar não desfaz (cláusula 12), então o dono vê o que já foi feito; depois o processador
	// trata o abort pelo caminho de cancelamento de sempre.
	if (input.signal?.aborted) await announceStoppedEffects(ports, input);
	input.signal?.throwIfAborted();
	if (result.status === "failed") throw new Error(`Motor v4 falhou: ${result.reason ?? "erro desconhecido"}`);
	const { stop, hitWall } = stopOf(result);
	// Estacionado (aprovação/entrega ao dono): o kernel não emite `final`; quem fecha o stream é o processador, que lança
	// `AgentRunPausedError("awaiting_owner")` (evento `paused` + lease solto). O checkpoint v4 já está salvo.
	return { text: result.text, model: meter.model(), hitWall, usage: meter.usage(), stop, parked: result.status === "parked" };
}
