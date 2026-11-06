// Montagem das portas reais do v4 no worker (F2.6): preset `full` com web, entregas ricas, memória, configurações,
// lista de tarefas e a ponte de conectores MCP do dono. Cada adaptador recebe as funções do db/clientes por injeção
// (os testes passam fakes; `realV4AdapterDeps` são as de produção).
import {
	PRESETS,
	createAgendaRunCapability,
	createCapabilityRegistry,
	createConnectorsCapability,
	createNoteTaskListStore,
	presetStablePrompt,
	setupPreset,
	type CapabilityId,
	type CapabilityRegistry,
	type Helpers,
	type NoteStore,
	type PolicyContext,
	type PresetDeps,
	type Search,
} from "@workspace/agent";
import type { ComputerUseEvent } from "@workspace/shared";
import { createV4Agenda, realV4AgendaDeps, type V4AgendaDeps } from "./agenda.js";
import { createV4Deliverables, realV4DeliverablesDeps, type V4DeliverablesDeps } from "./deliverables.js";
import { createV4Mcp, realV4McpDeps, type V4McpDeps } from "./mcp.js";
import { createV4Memory, realV4MemoryDeps, type V4MemoryDeps } from "./memory.js";
import { createV4Settings, realV4SettingsDeps, type V4SettingsDeps } from "./settings.js";
import { createV4Search, realV4WebDeps, type V4WebDeps } from "./web.js";

export type V4AdapterDeps = {
	web: V4WebDeps;
	deliverables: V4DeliverablesDeps;
	memory: V4MemoryDeps;
	settings: V4SettingsDeps;
	mcp: V4McpDeps;
	agenda: V4AgendaDeps;
};

export const realV4AdapterDeps = (): V4AdapterDeps => ({ web: realV4WebDeps(), deliverables: realV4DeliverablesDeps, memory: realV4MemoryDeps, settings: realV4SettingsDeps, mcp: realV4McpDeps, agenda: realV4AgendaDeps });

export type V4RegistryInput = {
	runId: string;
	/** Dono do run (a sessão): nunca vem do modelo. */
	userId: string;
	botId?: string | null;
	botName?: string | null;
	conversationId?: string | null;
	/** Rotina, webhook e follow-up: conectores só leem. */
	unattended: boolean;
	/** Notas do run (o caderno): a lista de tarefas fica nele. */
	notes: NoteStore;
	/** Evento ao vivo do contrato SSE (cartões de arquivo, painel e gráfico). */
	emit: (event: ComputerUseEvent) => void | Promise<void>;
	signal?: AbortSignal;
	deps?: V4AdapterDeps;
	/** Log técnico (sem segredo). */
	log?: (message: string) => void;
	/** Idioma do run (bot): a busca pede páginas nesse idioma. */
	locale?: string;
	/**
	 * Fábrica dos ajudantes (F3.1) do run. Recebe a MESMA porta de busca da mãe (os filhos leem pelas mesmas portas e
	 * registram as fontes) e vira `PresetDeps.helpers`, que a capacidade `research` (frente R) consome.
	 */
	makeHelpers?: (ctx: { search: Search }) => Helpers;
	/** Política do run: a agenda guarda a autonomia e as regras de quem cria o item (a permissão é decidida na criação). */
	policy?: Pick<PolicyContext, "autonomy" | "rules">;
	/**
	 * Run acordado pela agenda (F4.3): entra `agenda_result` (núcleo) e SAI a capacidade `agenda`, para um run de agenda
	 * nunca criar itens novos em cadeia.
	 */
	agendaRun?: boolean;
};

export type V4RegistrySetup = {
	registry: CapabilityRegistry;
	stableSystem: string;
	/** Capacidades do preset sem porta nesta montagem. */
	unavailable: CapabilityId[];
};

/**
 * Registro do preset `full` com as portas reais do run. Capacidade cuja porta não pode ser montada (ex.: configurações sem
 * bot no run) fica em `unavailable` e vai ao log. Falha ao listar os conectores não derruba o run: segue sem eles.
 */
export async function buildV4Registry(input: V4RegistryInput): Promise<V4RegistrySetup> {
	const deps = input.deps ?? realV4AdapterDeps();
	const log = input.log ?? ((message: string) => console.info(message));
	const botId = input.botId?.trim() || undefined;
	const deliverables = createV4Deliverables({
		runId: input.runId,
		scope: { conversationId: input.conversationId ?? null, botId: botId ?? null, emit: input.emit, log },
		deps: deps.deliverables,
	});
	const search = createV4Search(deps.web, input.locale);
	const agenda = botId ? createV4Agenda({ botId, policy: input.policy ?? { autonomy: "balanced", rules: [] }, deps: deps.agenda }) : undefined;
	const presetDeps: PresetDeps = {
		search,
		...(input.makeHelpers && { helpers: input.makeHelpers({ search }) }),
		files: deliverables.fileStore,
		deliverables: deliverables.ports,
		memory: createV4Memory({ botId, deps: deps.memory }),
		taskLists: createNoteTaskListStore(input.notes),
		// Configurações são do bot do run: sem bot não há o que configurar.
		...(botId && { settings: createV4Settings({ botId, deps: deps.settings }) }),
		// A agenda também é do bot do run (a conversa dele recebe o aviso).
		...(agenda && { agenda }),
	};
	const base = setupPreset("full", presetDeps);

	let connectors: Awaited<ReturnType<typeof createConnectorsCapability>> = { capability: null };
	try {
		const mcp = createV4Mcp({ scope: { ownerId: input.userId, unattended: input.unattended, botId: botId ?? null, botName: input.botName ?? null, conversationId: input.conversationId ?? null }, deps: deps.mcp });
		connectors = await createConnectorsCapability(mcp, input.userId, input.signal);
	} catch {
		log(`[engine-v4] run=${input.runId} conectores indisponíveis: falha ao listar as conexões do dono; o run segue sem eles`);
	}

	// Run de agenda: sai `agenda` (sem criar item em cadeia), entra `agenda_result` (núcleo).
	const capabilities = [...base.registry.capabilities, ...(connectors.capability ? [connectors.capability] : [])];
	const forRun = input.agendaRun && agenda ? [...capabilities.filter((capability) => capability.id !== "agenda"), createAgendaRunCapability(agenda)] : capabilities;
	const registry = forRun.length === base.registry.capabilities.length && !connectors.capability ? base.registry : createCapabilityRegistry(forRun);
	if (base.unavailable.length > 0) log(`[engine-v4] run=${input.runId} capacidades sem porta: ${base.unavailable.join(", ")}`);
	return {
		registry,
		stableSystem: registry === base.registry ? base.stableSystem : presetStablePrompt(PRESETS.full, registry),
		unavailable: base.unavailable,
	};
}
