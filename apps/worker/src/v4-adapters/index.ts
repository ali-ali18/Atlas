// Montagem das portas reais do v4 no worker (F2.6): preset `full` com web, entregas ricas, memória, configurações,
// lista de tarefas e a ponte de conectores MCP do dono. Cada adaptador recebe as funções do db/clientes por injeção
// (os testes passam fakes; `realV4AdapterDeps` são as de produção).
import {
	PRESETS,
	createAgendaRunCapability,
	createBriefCapability,
	createBrowserCapability,
	createCalendarCapability,
	createCapabilityRegistry,
	createConnectorsCapability,
	createEmailCapability,
	createNoteTaskListStore,
	createShoppingCapability,
	createVaultAdapter,
	presetStablePrompt,
	setupPreset,
	type CapabilityId,
	type CapabilityRegistry,
	type Helpers,
	type NoteStore,
	type PolicyContext,
	type BriefEmailSource,
	type CheckoutDeps,
	type CodeDeps,
	type PresetDeps,
	type Search,
} from "@workspace/agent";
import { countryFromLocale, type AgendaKind, type ComputerUseEvent, type RoutineRecord } from "@workspace/shared";
import { createV4Bots, isBotDecideEnabled, realV4BotsDeps, type V4BotsDeps } from "./bots.js";
import { createV4Agenda, realV4AgendaDeps, type V4AgendaDeps } from "./agenda.js";
import { createV4Attachments, type V4AttachmentsSource } from "./attachments.js";
import { createV4Email, realV4EmailDeps, type V4EmailDeps } from "./email.js";
import { createV4Github, realV4GithubDeps, type V4GithubDeps } from "./github.js";
import { createV4Images, realV4ImagesDeps, type V4ImagesConfig, type V4ImagesDeps } from "./images.js";
import { createV4Brief, realV4BriefDeps, type V4BriefDeps } from "./brief.js";
import { createV4Calendar, realV4CalendarDeps, type V4CalendarDeps } from "./calendar.js";
import { createV4Deliverables, realV4DeliverablesDeps, type V4DeliverablesDeps } from "./deliverables.js";
import { createV4Mcp, realV4McpDeps, type V4McpDeps } from "./mcp.js";
import { createV4Memory, realV4MemoryDeps, type V4MemoryDeps } from "./memory.js";
import { createV4Notebook, realV4NotebookDeps, type V4NotebookDeps } from "./notebook.js";
import { createV4Routines, realV4RoutinesDeps, type V4RoutinesDeps } from "./routines.js";
import { createV4Settings, realV4SettingsDeps, type V4SettingsDeps } from "./settings.js";
import { createV4Shopping, realV4ShoppingDeps, type V4ShoppingDeps } from "./shopping.js";
import { createV4Skills, loadV4SkillNames, realV4SkillsDeps, type V4SkillsDeps } from "./skills.js";
import { createV4Vault, realV4VaultDeps, type V4VaultDeps } from "./vault.js";
import { createV4Search, realV4WebDeps, type V4WebDeps } from "./web.js";

export type V4AdapterDeps = {
	web: V4WebDeps;
	deliverables: V4DeliverablesDeps;
	memory: V4MemoryDeps;
	notebook: V4NotebookDeps;
	settings: V4SettingsDeps;
	mcp: V4McpDeps;
	agenda: V4AgendaDeps;
	shopping: V4ShoppingDeps;
	email: V4EmailDeps;
	calendar: V4CalendarDeps;
	brief: V4BriefDeps;
	images: V4ImagesDeps;
	vault: V4VaultDeps;
	github: V4GithubDeps;
	bots: V4BotsDeps;
	routines: V4RoutinesDeps;
	skills: V4SkillsDeps;
};

export const realV4AdapterDeps = (): V4AdapterDeps => ({ web: realV4WebDeps(), deliverables: realV4DeliverablesDeps, memory: realV4MemoryDeps, notebook: realV4NotebookDeps, settings: realV4SettingsDeps, mcp: realV4McpDeps, agenda: realV4AgendaDeps, shopping: realV4ShoppingDeps, email: realV4EmailDeps, calendar: realV4CalendarDeps, brief: realV4BriefDeps, images: realV4ImagesDeps, vault: realV4VaultDeps, github: realV4GithubDeps, bots: realV4BotsDeps, routines: realV4RoutinesDeps, skills: realV4SkillsDeps });

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
	/** Tipo do item de agenda que acordou o run (F7.2): `brief` troca o registro pelo do plano do dia. */
	agendaKind?: AgendaKind;
	/** Fonte de e-mail do plano do dia (frente de e-mail, `listRecent`). Opcional: sem ela o brief segue sem a seção. */
	briefEmail?: BriefEmailSource;
	/** Pagamento (F6.3): cartões do dono (bandeira e final) e o `card_fill`. Sem cartão salvo, a tool `checkout` não entra na capacidade `shopping`. */
	checkout?: CheckoutDeps;
	/** A VM do navegador existe neste run (adaptador `Sandbox` real, F8.1). Sem ela `browser` fica em `unavailable`, dito com honestidade. */
	browser?: boolean;
	/** Código (F8.2), opt-in do bot: o modo de código está ligado E o ambiente de código existe. `readOnly` = modo plano. */
	code?: CodeDeps;
	/** O bot ligou o modo de código (`policyJson.codeMode`). Se ligou e `code` não veio, o ambiente de código está desligado: entra em `unavailable`. */
	codeRequested?: boolean;
	/** O ambiente de código existe neste servidor (dev sandbox). Serve para `settings_set_code_mode` ser honesta ao ligar sem ele. */
	codeEnvironment?: boolean;
	/** Imagens (F9): chave e modelo de imagem do run (modelo do dono, ou `ATLAS_IMAGE_MODEL`). Sem ele a tool avisa como configurar. Em run sem dono a capacidade não entra. */
	imageGeneration?: V4ImagesConfig;
	/** Rotinas (F9): sincroniza o agendador depois de pausar, retomar ou apagar uma rotina (o `syncRoutineScheduler` do worker). Sem ele a rotina muda no banco e o agendador só reconcilia no próximo boot. */
	onRoutineMutated?: (routine: RoutineRecord) => Promise<unknown>;
	/** Anexos da conversa (F9): a fonte do run (lista e cache de extração). Só com dono presente; rotina e agenda não leem anexos. */
	attachments?: V4AttachmentsSource;
	/** Rotinas (F9): reconcilia o webhook do repositório no GitHub depois de pausar, retomar ou apagar uma rotina de GitHub (o `ensureGithubRepoHook` do legado). Sem ele o hook no GitHub só muda quando o legado mexer na rotina. */
	ensureGithubHook?: (userId: string, repo: string) => Promise<unknown>;
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
	const shoppingPorts = createV4Shopping({ scope: { conversationId: input.conversationId ?? null, botId: botId ?? null, emit: input.emit, log }, deps: deps.shopping });
	const emailPorts = createV4Email({ scope: { ownerId: input.userId, botId: botId ?? null, conversationId: input.conversationId ?? null, emit: input.emit, log }, deps: deps.email });
	// Cofre (F9): nomes e metadados para o modelo; o valor só vai ao executor. Sem dono presente só `secret_list` (sem pedir nem digitar).
	const vaultPorts = createV4Vault({ scope: { conversationId: input.conversationId ?? null, botId: botId ?? null, botName: input.botName ?? null, emit: input.emit, log }, deps: deps.vault });
	// Rotinas (F9): as da Biblioteca, do bot do run (sem bot não há o que listar). Sem dono presente só `routine_list`.
	const routinesPort = botId ? createV4Routines({ scope: { botId, conversationId: input.conversationId ?? null, emit: input.emit, log, ...(input.onRoutineMutated && { onMutated: input.onRoutineMutated }), ...(input.ensureGithubHook && { ensureGithubHook: input.ensureGithubHook }) }, deps: deps.routines }) : undefined;
	const country = countryFromLocale(input.locale);
	// Anexos (F9): só com dono presente. Rotina e run de agenda leem a conversa sem ninguém para ver o que é lido, então não entram.
	const attachmentsPort = input.attachments && !input.unattended && !input.agendaRun ? createV4Attachments({ scope: { ownerId: input.userId, conversationId: input.conversationId ?? null }, source: input.attachments }) : undefined;
	const calendarPorts = createV4Calendar({ scope: { botId: botId ?? null, conversationId: input.conversationId ?? null, emit: input.emit, log }, deps: deps.calendar });
	// Imagens (F9): sem dono presente o gasto de provedor não tem quem aprove, então a porta nem entra (a capacidade fica fora).
	const images = input.unattended ? undefined : createV4Images({ scope: { conversationId: input.conversationId ?? null, emit: input.emit, log }, ...(input.imageGeneration && { config: input.imageGeneration }), deps: deps.images });
	// Bots (F9): só com dono presente e bot no run. Sem dono (rotina, agenda, bot a bot) a capacidade nem entra: não há quem
	// confirme, e mensagem a outro bot a partir de conteúdo de fora não pode partir de um run sem humano.
	const bots = botId && !input.unattended ? createV4Bots({ scope: { botId, conversationId: input.conversationId ?? null, emit: input.emit, log, decideEnabled: await isBotDecideEnabled(botId, input.userId, deps.bots) }, deps: deps.bots }) : undefined;
	// Habilidades (F9): as da conta e as deste bot. Só o índice de NOMES vai (curto) no resumo da capacidade; o corpo só com `skill_read`.
	// Sem dono presente (rotina, agenda, subagente) só lê e usa: ninguém para ver o aviso "Aprendi" nem desfazer.
	const skillsPort = createV4Skills({ scope: { botId: botId ?? null, conversationId: input.conversationId ?? null, emit: input.emit, log }, deps: deps.skills });
	const skillNames = await loadV4SkillNames({ userId: input.userId, botId: botId ?? null, deps: deps.skills, log });
	const presetDeps: PresetDeps = {
		search,
		...(input.makeHelpers && { helpers: input.makeHelpers({ search }) }),
		files: deliverables.fileStore,
		deliverables: deliverables.ports,
		memory: createV4Memory({ botId, deps: deps.memory }),
		notebook: createV4Notebook({ botId, runId: input.runId, deps: deps.notebook }),
		taskLists: createNoteTaskListStore(input.notes),
		// Configurações são do bot do run: sem bot não há o que configurar.
		...(botId && { settings: createV4Settings({ botId, deps: deps.settings, codeEnvironment: input.codeEnvironment === true }) }),
		// Compras (F6): a compra gravada cria o vigia de entrega pela agenda do preset (por isso só entra com bot).
		shopping: shoppingPorts,
		// E-mail (F7.1): Gmail do dono e caixa do bot; as contas são resolvidas na chamada (nenhuma leitura ao montar).
		email: emailPorts,
		// A agenda também é do bot do run (a conversa dele recebe o aviso).
		...(agenda && { agenda }),
		calendar: calendarPorts,
		...(input.checkout && { checkout: input.checkout }),
		...(input.browser && { browser: true }),
		// Vídeo (F9): a transcrição roda na mesma VM do navegador; sem ela a capacidade fica em `unavailable`.
		...(input.browser && { video: true }),
		vault: { vault: createVaultAdapter(vaultPorts.backend), ...(vaultPorts.requests && { requests: vaultPorts.requests }), ...(input.unattended && { readOnly: true }) },
		// GitHub (F9, leitura): o token é o do dono do run, resolvido na chamada (nada é lido ao montar). O conector GitHub continua no run: é por ele que se escreve.
		github: { github: createV4Github(deps.github) },
		...(bots && { bots: { bots } }),
		...(routinesPort && { routines: { routines: routinesPort, ...(input.unattended && { readOnly: true }) } }),
		...(attachmentsPort && { attachments: { files: attachmentsPort } }),
		skills: { skills: skillsPort, names: skillNames, ...((input.unattended || input.agendaRun) && { readOnly: true }) },
		...(input.code && { code: input.code }),
		...(images && { images }),
		...(country && { shoppingCountry: country }),
	};
	const preset = setupPreset("full", presetDeps);
	const base = preset;

	let connectors: Awaited<ReturnType<typeof createConnectorsCapability>> = { capability: null };
	try {
		const mcp = createV4Mcp({ scope: { ownerId: input.userId, unattended: input.unattended, botId: botId ?? null, botName: input.botName ?? null, conversationId: input.conversationId ?? null }, deps: deps.mcp });
		// Com `email`/`calendar` nativos no run, o conector embutido (e as tools de Gmail/Agenda do Composio) que os duplica sai: ele contornaria a aprovação e as regras.
		const nativeIds = new Set(base.registry.capabilities.map((capability) => capability.id));
		connectors = await createConnectorsCapability(mcp, input.userId, input.signal, { email: nativeIds.has("email"), calendar: nativeIds.has("calendar") });
	} catch {
		log(`[engine-v4] run=${input.runId} conectores indisponíveis: falha ao listar as conexões do dono; o run segue sem eles`);
	}

	// Run de agenda: sai `agenda` (sem criar item em cadeia), entra `agenda_result` (núcleo).
	const capabilities = [...base.registry.capabilities, ...(connectors.capability ? [connectors.capability] : [])];
	const asAgendaRun = Boolean(input.agendaRun && agenda);
	// No run de agenda, `shopping` perde a agenda e as tools de escrita (`readOnly`): ali o conteúdo vem de fora e não há dono para
	// confirmar, então registrar compra (e criar vigia em cadeia) seria obedecer uma página.
	// `email` também só lê ali: rascunho e envio agiriam sobre texto de fora, sem dono para revisar.
	// Plano do dia (F7.2): o run só tem `agenda_result` e as duas tools do brief. Nada de web, escrita ou conectores: o conteúdo
	// lido (e-mail, eventos) é de terceiros e o run não tem dono. O calendário entra só para LER, por porta.
	const asBrief = asAgendaRun && input.agendaKind === "brief" && agenda;
	const briefPorts = asBrief ? createV4Brief({ scope: { botId: botId ?? null, conversationId: input.conversationId ?? null, emit: input.emit, log }, deps: deps.brief }) : null;
	const forRun =
		asBrief && agenda && briefPorts
			? [createAgendaRunCapability(agenda), createBriefCapability({ agenda, calendar: calendarPorts.calendar, notebook: createV4Notebook({ botId, runId: input.runId, deps: deps.notebook }), deliveries: briefPorts.deliveries, ...(briefPorts.tasks && { tasks: briefPorts.tasks }), ...(input.briefEmail && { email: input.briefEmail }), cards: briefPorts.cards })]
			: asAgendaRun && agenda
				? [...capabilities.filter((capability) => capability.id !== "agenda" && capability.id !== "shopping" && capability.id !== "calendar" && capability.id !== "email" && capability.id !== "browser"), createAgendaRunCapability(agenda), createShoppingCapability({ ...shoppingPorts, search, readOnly: true, ...(country && { country }) }), createEmailCapability({ ...emailPorts, readOnly: true }), createCalendarCapability({ calendar: calendarPorts.calendar, readOnly: true }), createBrowserCapability({ readOnly: true })]
				: capabilities;
	// Sem dono presente (rotina, subagente, bot a bot, agenda) o navegador só lê: nada a enviar e ninguém para confirmar. O run de
	// agenda já trocou o `browser` acima; os demais sem dono trocam aqui (mantém o `browser_digest` quando há ajudantes).
	const readOnlyBrowser = input.unattended && !asAgendaRun && forRun.some((capability) => capability.id === "browser");
	const finalCaps = readOnlyBrowser ? forRun.map((capability) => (capability.id === "browser" ? createBrowserCapability({ readOnly: true, ...(input.makeHelpers && { helpers: input.makeHelpers({ search }) }) }) : capability)) : forRun;
	const registry = !asAgendaRun && !connectors.capability && !readOnlyBrowser ? base.registry : createCapabilityRegistry(finalCaps);
	// `browser` fica em `unavailable` sem a VM (SANDBOX_ENABLED desligado); `code` é opt-in e só aparece aqui se o bot ligou e o ambiente não existe.
	const unavailable: CapabilityId[] = [...base.unavailable, ...(input.codeRequested && !input.code ? (['code'] as const) : [])];
	if (unavailable.length > 0) log(`[engine-v4] run=${input.runId} capacidades sem porta: ${unavailable.join(", ")}`);
	return {
		registry,
		stableSystem: registry === base.registry ? base.stableSystem : presetStablePrompt(PRESETS.full, registry),
		unavailable,
	};
}
