// Presets do motor v4 (03 §8): dados, não código. Dizem quais capacidades entram e se o contrato de trabalho
// vai no prompt estável. `minimal` é o preset do teste de fumaça e do eval; `full` cresce com as fases.
import type { CapabilityRegistry } from "../capabilities/registry.js";
import { createCapabilityRegistry } from "../capabilities/registry.js";
import { createDeliverablesCapability } from "../capabilities-builtin/deliverables/index.js";
import { createResearchCapability } from "../capabilities-builtin/research/index.js";
import type { DeliverablePorts } from "../ports/deliverables.js";
import { createAgendaCapability } from "../capabilities/agenda/index.js";
import { type CodeDeps, createCodeCapability } from "../capabilities/code/index.js";
import { createCalendarCapability } from "../capabilities/calendar/index.js";
import type { CalendarPorts } from "../ports/calendar.js";
import { createMemoryCapability } from "../capabilities/memory/index.js";
import { createEmailCapability } from "../capabilities/email/index.js";
import { createShoppingCapability } from "../capabilities/shopping/index.js";
import type { EmailPorts } from "../ports/email.js";
import type { ShoppingPorts } from "../ports/shopping.js";
import { createSettingsCapability } from "../capabilities/settings/index.js";
import type { CheckoutDeps } from "../capabilities/shopping/checkout.js";
import { createTasksCapability } from "../capabilities/tasks/index.js";
import type { Agenda } from "../ports/agenda.js";
import type { FileStore } from "../ports/file-store.js";
import type { Helpers } from "../ports/helpers.js";
import type { Memory } from "../ports/memory.js";
import type { Notebook } from "../ports/notebook.js";
import type { Search } from "../ports/search.js";
import type { Settings } from "../ports/settings.js";
import type { TaskListStore } from "../ports/task-list.js";
import { buildStablePrompt } from "../prompt/work-contract.js";
import { createDeliverablesLiteCapability } from "./deliverables-lite.js";
import { createWebCapability } from "./web.js";

export const PRESET_IDS = ["minimal", "full"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export type CapabilityId = "web" | "deliverables-lite" | "memory" | "tasks" | "settings" | "research" | "agenda" | "shopping" | "email" | "calendar" | "code";

export type AgentPreset = {
	id: PresetId;
	/** Capacidades registradas. As não-núcleo (memory, tasks, settings) são lazy: só o índice vai no prompt. */
	capabilities: readonly CapabilityId[];
	/** O contrato de trabalho entra no prompt estável? */
	workContract: boolean;
};

export const PRESETS: Readonly<Record<PresetId, AgentPreset>> = Object.freeze({
	minimal: Object.freeze({ id: "minimal", capabilities: Object.freeze(["web", "deliverables-lite"] as const), workContract: false }),
	full: Object.freeze({ id: "full", capabilities: Object.freeze(["web", "deliverables-lite", "memory", "tasks", "settings", "research", "agenda", "shopping", "email", "calendar"] as const), workContract: true }),
});

/**
 * `memory`, `settings` e `taskLists` são opcionais: a capacidade cuja porta falta não entra (e `setupPreset` a lista em
 * `unavailable`). `deliverables` (F2.3): com as portas, a capacidade lazy `deliverables` (docx, pdf, xlsx, pptx, painel,
 * gráfico) entra no lugar da `deliverables-lite`; sem elas, segue a versão mínima de texto.
 */
export type PresetDeps = {
	search: Search;
	files: FileStore;
	deliverables?: DeliverablePorts;
	memory?: Memory;
	/** Caderno do dono (F5.1): junto da memória, vira as tools `note_*` da mesma capacidade lazy. Sem a porta, só a memória. */
	notebook?: Notebook;
	settings?: Settings;
	taskLists?: TaskListStore;
	/** Ajudantes (F3.1): runs filhos do próprio kernel. A capacidade `research` (frente R) os recebe aqui; o worker monta por run. */
	helpers?: Helpers;
	/** Agenda (F4.2): lembrete, vigia e intenção por evento. Lazy; sem a porta a capacidade não entra. */
	agenda?: Agenda;
	/** Compras (F6): leitura estruturada de produto e compra registrada. Lazy; sem as portas a capacidade não entra. */
	shopping?: ShoppingPorts;
	/** Pagamento (F6.3): cartões do dono (só bandeira e final) e o `card_fill`. A tool `checkout` entra na capacidade `shopping` só com cartão salvo. */
	checkout?: CheckoutDeps;
	/** País do dono (ISO alfa-2) para o frete por destino da página de produto. */
	shoppingCountry?: string;
	/** E-mail (F7.1): Gmail do dono e caixa do bot. Lazy; sem as portas a capacidade não entra. */
	email?: EmailPorts;
	/** Google Agenda do dono (F7.1). Lazy; sem a porta a capacidade não entra. */
	calendar?: CalendarPorts;
	/** Código (F8.2): sessão de código na VM, pela porta `Sandbox` do run. Lazy; sem esta chave a capacidade não entra (o worker liga quando o adaptador `code.*` existe). `readOnly` = modo plano. */
	code?: CodeDeps;
};

export function isPresetId(value: unknown): value is PresetId {
	return typeof value === "string" && (PRESET_IDS as readonly string[]).includes(value);
}

type CapabilityFactory = (deps: PresetDeps) => ReturnType<typeof createWebCapability> | undefined;

const FACTORIES: Readonly<Record<CapabilityId, CapabilityFactory>> = {
	web: (deps) => createWebCapability(deps.search),
	"deliverables-lite": (deps) => (deps.deliverables ? createDeliverablesCapability(deps.deliverables) : createDeliverablesLiteCapability(deps.files)),
	memory: (deps) => deps.memory && createMemoryCapability(deps.memory, deps.notebook),
	tasks: (deps) => deps.taskLists && createTasksCapability(deps.taskLists),
	settings: (deps) => deps.settings && createSettingsCapability(deps.settings),
	// F3.2: pesquisa em plano; só entra quando a porta dos ajudantes existe (a frente H a implementa).
	research: (deps) => deps.helpers && createResearchCapability(deps.helpers),
	// F4.2: lazy como as demais (o núcleo do plano é "agenda disponível", não "schema sempre carregado": "Bom dia" segue barato).
	agenda: (deps) => deps.agenda && createAgendaCapability(deps.agenda),
	// F6: lazy; a compra grava o vigia de entrega pela agenda do próprio preset.
	// F7.1: Google Agenda do dono; lazy como as demais.
	calendar: (deps) => deps.calendar && createCalendarCapability(deps.calendar),
	shopping: (deps) => deps.shopping && createShoppingCapability({ ...deps.shopping, search: deps.search, ...(deps.agenda && { agenda: deps.agenda }), ...(deps.checkout && { checkout: deps.checkout }), ...(deps.shoppingCountry && { country: deps.shoppingCountry }) }),
	// F7.1: lazy; ler, triar e rascunhar livres, enviar sempre com a aprovação do dono.
	email: (deps) => deps.email && createEmailCapability(deps.email),
	// F8.2: lazy; "Bom dia" não carrega o schema. As tools falam com a porta `Sandbox` (kinds `code.*`).
	code: (deps) => deps.code && createCodeCapability(deps.code),
};

/**
 * Capacidades opt-in: não fazem parte de nenhum preset, entram quando a dependência vem nas `deps`. O código (F8.2) liga por
 * run ou bot (`code: {}`; `code: { readOnly: true }` no modo plano): o worker só passa a chave quando o adaptador `code.*` existe.
 * Assim `full` não ganha uma capacidade "indisponível" em quem não usa código, e nada some em silêncio.
 */
const OPT_IN: readonly CapabilityId[] = ["code"];

function capabilitiesOf(preset: AgentPreset, deps: PresetDeps): readonly CapabilityId[] {
	const extra = OPT_IN.filter((id) => !preset.capabilities.includes(id) && FACTORIES[id](deps) !== undefined);
	return [...preset.capabilities, ...extra];
}

/** Capacidades do preset que não entram por falta da porta. */
export function unavailableCapabilities(preset: AgentPreset, deps: PresetDeps): CapabilityId[] {
	return preset.capabilities.filter((id) => FACTORIES[id](deps) === undefined);
}

export function buildPresetRegistry(preset: AgentPreset, deps: PresetDeps): CapabilityRegistry {
	const built = capabilitiesOf(preset, deps).map((id) => FACTORIES[id](deps)).filter((capability): capability is NonNullable<typeof capability> => capability !== undefined);
	return createCapabilityRegistry(built);
}

/** Prompt estável do preset: sem contrato de trabalho no `minimal`. */
export function presetStablePrompt(preset: AgentPreset, registry: CapabilityRegistry): string {
	return buildStablePrompt(registry, { workContract: preset.workContract });
}

export type PresetSetup = { preset: AgentPreset; registry: CapabilityRegistry; stableSystem: string; unavailable: CapabilityId[] };

export function setupPreset(id: PresetId, deps: PresetDeps): PresetSetup {
	const preset = PRESETS[id];
	const registry = buildPresetRegistry(preset, deps);
	return { preset, registry, stableSystem: presetStablePrompt(preset, registry), unavailable: unavailableCapabilities(preset, deps) };
}
