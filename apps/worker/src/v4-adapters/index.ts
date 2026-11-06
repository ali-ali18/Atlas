// Montagem das portas reais do v4 no worker (F2.6): preset `full` com web, entregas ricas, memória, configurações,
// lista de tarefas e a ponte de conectores MCP do dono. Cada adaptador recebe as funções do db/clientes por injeção
// (os testes passam fakes; `realV4AdapterDeps` são as de produção).
import {
	PRESETS,
	createCapabilityRegistry,
	createConnectorsCapability,
	createNoteTaskListStore,
	presetStablePrompt,
	setupPreset,
	type CapabilityId,
	type CapabilityRegistry,
	type NoteStore,
	type PresetDeps,
} from "@workspace/agent";
import type { ComputerUseEvent } from "@workspace/shared";
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
};

export const realV4AdapterDeps = (): V4AdapterDeps => ({ web: realV4WebDeps(), deliverables: realV4DeliverablesDeps, memory: realV4MemoryDeps, settings: realV4SettingsDeps, mcp: realV4McpDeps });

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
	const presetDeps: PresetDeps = {
		search: createV4Search(deps.web),
		files: deliverables.fileStore,
		deliverables: deliverables.ports,
		memory: createV4Memory({ botId, deps: deps.memory }),
		taskLists: createNoteTaskListStore(input.notes),
		// Configurações são do bot do run: sem bot não há o que configurar.
		...(botId && { settings: createV4Settings({ botId, deps: deps.settings }) }),
	};
	const base = setupPreset("full", presetDeps);

	let connectors: Awaited<ReturnType<typeof createConnectorsCapability>> = { capability: null };
	try {
		const mcp = createV4Mcp({ scope: { ownerId: input.userId, unattended: input.unattended, botId: botId ?? null, botName: input.botName ?? null, conversationId: input.conversationId ?? null }, deps: deps.mcp });
		connectors = await createConnectorsCapability(mcp, input.userId, input.signal);
	} catch {
		log(`[engine-v4] run=${input.runId} conectores indisponíveis: falha ao listar as conexões do dono; o run segue sem eles`);
	}

	const registry = connectors.capability ? createCapabilityRegistry([...base.registry.capabilities, connectors.capability]) : base.registry;
	if (base.unavailable.length > 0) log(`[engine-v4] run=${input.runId} capacidades sem porta: ${base.unavailable.join(", ")}`);
	return {
		registry,
		stableSystem: connectors.capability ? presetStablePrompt(PRESETS.full, registry) : base.stableSystem,
		unavailable: base.unavailable,
	};
}
