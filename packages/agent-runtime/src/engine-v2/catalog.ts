/**
 * Motor v2: catálogo de tools. Núcleo sempre carregado, grupos raros adiados com um índice curto no prompt e
 * `mcp_tool_search` para carregar por nome ou necessidade (o mesmo mecanismo do v1). O roteador de intenção
 * (regex) vira só DICA de pré-carga: nunca decide o que existe, porque tudo é carregável a pedido do modelo.
 *
 * O v2 atende a conversa direta (origem `chat`) e, com o escopo ampliado do bot, rotina (inclui alerta, brief e
 * "só importante"), grupo, bot→bot, proativo, webhook e e-mail recebido, com as mesmas tools e condições do v1
 * (`send_to_bot`, `decide_bot_pending`, `report_alert`, `notify_user`, follow-ups). Ficam de fora as tools de subagente
 * do v1 (o v2 tem `delegate`), `set_primary_bot` e a sessão de código (ver docs/features/motor-v2.md).
 * As regras por origem espelham as do v1 (`computer-use.ts`): rotina não recebe gestão de rotinas, pesquisa web,
 * memória nem pedido de senha; sem humano (rotina/webhook) só entra conector que a autonomia libera sem perguntar.
 */
import type { ChatTool } from "@workspace/llm";
import { decideAction, hostAutonomyMeta, type EffectiveAutonomy } from "@workspace/shared";
import { loadCodeRunnerConfig } from "@workspace/sandbox";
import { COMPUTER_USE_TOOLS, TOOL_SEARCH_WITH_BUILTINS } from "../computer-use.js";
import { createNativeDeferral, type NativeDeferral } from "../context/native-deferral.js";
import { deferredToolsIndex, planNativeTools } from "../context/native-tools.js";
import { routeContextGroups } from "../context/intent-router.js";
import { economyRouterText, orderEconomyTools } from "../context/economy.js";
import type { ContextGroup } from "../context/prompt-blocks.js";
import { API_CALL_TOOL, API_SEARCH_TOOL, PROPOSE_API_CONNECTION_TOOL } from "../api-connector/tools.js";
import { emailToolsFor, type EmailRunContext } from "../email/tools.js";
import { SHOW_IMAGE_TOOL } from "../tools/show-image.js";
import { ATTACHMENT_LIST_TOOL, ATTACHMENT_READ_TOOL, ATTACHMENT_TO_COMPUTER_TOOL } from "../tools/attachment-tools.js";
import { GENERATE_IMAGE_TOOL } from "../tools/generate-image.js";
import { CREATE_FILE_TOOL } from "../tools/create-file.js";
import { INSPECT_PRESENTATION_TOOL } from "../tools/inspect-presentation.js";
import { PAGE_READ_TOOL_NAME, PAGE_TOOLS, PAGE_UPDATE_TOOL_NAME } from "../tools/pages.js";
import { RUN_CODE_TOOL } from "../tools/run-code.js";
import { UPDATE_TASK_LIST_TOOL, shouldExposeTaskList } from "../tools/task-list.js";
import { ROUTINE_EXCLUDED_TOOLS } from "../tools/routine-excluded.js";
import { isUnattendedOrigin } from "../autonomy-gate.js";
import { SANDBOX_TOOL_NAMES } from "../tools/registry/sandbox-tools.js";
import { SANDBOX_SHELL_TOOL_NAMES, sandboxShellAllowedForOrigin, sandboxShellBlocked, type SandboxShellToolName } from "../tools/sandbox-shell.js";
import { SANDBOX_RELEASE_TOOL_NAME } from "../tools/sandbox-release.js";
import { MCP_MAX_EXPOSED_TOOLS, MCP_MAX_TOOLS_JSON_CHARS } from "../mcp/registry.js";
import { planMcpActivation } from "../mcp/activation.js";
import type { McpRuntime } from "../mcp/runtime.js";
import { skillDeleteBlocked, skillWriteBlocked } from "../tools/skills.js";
import { LESSON_FEEDBACK_TOOL_NAME } from "../tools/lesson-feedback.js";
import { PREVIEW_SETUP_TOOL_NAME } from "../tools/preview-setup/tool.js";
import { DELEGATE_V2_TOOL } from "./helpers.js";
import { NOTEBOOK_READ_TOOL, NOTEBOOK_WRITE_TOOL } from "./notebook.js";
import { SET_ENGINE_TOOL } from "../tools/set-engine.js";
import { notifyUserPushTool, proactiveToolsFor, type UserPushMode } from "../tools/proactive.js";
import { REPORT_ALERT_TOOL } from "../tools/report-alert.js";
import { SEND_TO_BOT_TOOL, shouldExposeSendToBot } from "../tools/bot-messaging.js";
import { DECIDE_BOT_PENDING_TOOL, shouldExposeDecideBotPending } from "../tools/bot-pending.js";

const SKILL_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["propose_skill", "delete_skill"]);

/** Tools de COMPUTER_USE_TOOLS que o v2 ainda não atende nesta fase (precisam de estado do laço do v1). */
const NOT_IN_V2: ReadonlySet<string> = new Set([LESSON_FEEDBACK_TOOL_NAME, PREVIEW_SETUP_TOOL_NAME]);

export type EngineV2Catalog = {
	/** Array enviado ao modelo (mutado in place: carregar tool entra no FIM, sem reordenar o prefixo). */
	tools: ChatTool[];
	deferral: NativeDeferral | null;
	/** Índice curto das famílias adiadas para o prompt ("" sem adiadas). */
	index: string;
	/** Grupos pré-carregados pela dica do roteador. */
	preloaded: Set<ContextGroup>;
	/** Procedimentos já presentes no prompt (mutável: `load` acrescenta). */
	promptedGroups: Set<ContextGroup>;
	/** Ativa tools de conector por nome (mesma regra de teto/LRU do v1). */
	activateMcpTools: (names: string[]) => { activated: string[]; evicted: string[] };
	/** Nomes das tools de conector ativas. */
	activeMcpTools: () => string[];
	/** Tool de conector chamada fica fixa no run (não sai no LRU). */
	pinMcpTool: (name: string) => void;
};

export function buildEngineV2Catalog(input: {
	origin: string;
	userId: string;
	sandboxEnabled: boolean;
	autonomy: EffectiveAutonomy;
	toolFilter?: (name: string) => boolean;
	mcp: McpRuntime | null;
	apiConnector: boolean;
	email?: EmailRunContext | null;
	attachments: { present: boolean };
	planMode?: boolean;
	/** Perfil do bot permite `propose_profile_update` (onboarding ou pedido explícito). */
	allowProfileUpdate: boolean;
	hasImageAttachments: boolean;
	routerMessages: ReadonlyArray<{ role: string; content?: unknown }>;
	lastUserMessage: string;
	objective?: string;
	/** Tools carregadas em turnos anteriores / retomada. */
	priorLoadedTools?: readonly string[];
	/** Trabalho longo: ganha o caderno da tarefa (e `delegate` com `helpers`). Em conversa curta nada disto é carregado. */
	longWork?: boolean;
	/** Este run é um ajudante: só `notebook_write` além das tools de leitura que o filtro permite. */
	helper?: boolean;
	/** O coordenador pode delegar (chat direto de usuário real, fora de ajudante). */
	helpers?: boolean;
	/** O dono (digitando) pediu para ligar/desligar/ajustar o motor: `set_engine` entra. */
	setEngine?: boolean;
	/** Rotina ligada a um painel: só ler e atualizar esse painel (o executor trava os outros). */
	routinePageId?: string;
	/** Modo proativo do bot neste run (`params.proactive`): follow-ups, ideias de rotina e, na reflexão, `notify_user`. */
	proactive?: { hasConversation: boolean };
	/** Push avulso (`params.userPush`): `notify_user` só-push na rotina "só importante" e no chat. */
	userPush?: UserPushMode;
	/** Rotina de alerta (`params.alertRun`): `report_alert` entra e é o fim da verificação. */
	alertRun?: boolean;
	/** Conversa entre bots (chat do dono e bot→bot): quantos bots o dono tem e se "decidir pelos outros bots" está ligado. */
	botMessaging?: { botCount: number; decideForOtherBots: boolean };
}): EngineV2Catalog {
	const allow = (name: string) => input.toolFilter?.(name) ?? true;
	const hostBlocked = (name: string) =>
		(name === "propose_profile_update" && decideAction(input.autonomy, hostAutonomyMeta(name)) === "block") ||
		(name === "propose_skill" && skillWriteBlocked(input.autonomy)) ||
		(name === "delete_skill" && skillDeleteBlocked(input.autonomy));

	const native: ChatTool[] = [];
	const seen = new Set<string>();
	const add = (tool: ChatTool) => {
		const name = tool.function.name;
		if (seen.has(name) || !allow(name) || hostBlocked(name)) return;
		seen.add(name);
		native.push(tool);
	};
	for (const tool of COMPUTER_USE_TOOLS) {
		const name = tool.function.name;
		if (NOT_IN_V2.has(name)) continue;
		if (!input.sandboxEnabled && SANDBOX_TOOL_NAMES.has(name)) continue;
		if (name === "propose_profile_update" && !input.allowProfileUpdate) continue;
		// Sem humano (rotina, webhook): um questionário pararia o run em `awaiting_confirmation` sem ninguém para responder.
		if (name === "propose_questionnaire" && isUnattendedOrigin(input.origin)) continue;
		if (name === "login_fill" && !input.sandboxEnabled) continue;
		// Rotina/webhook não desliga a VM que o dono pode estar usando; quem libera memória é o guarda.
		if (name === SANDBOX_RELEASE_TOOL_NAME && (!input.sandboxEnabled || isUnattendedOrigin(input.origin))) continue;
		if (input.origin === "routine" && ROUTINE_EXCLUDED_TOOLS.has(name)) continue;
		if ((name === "propose_connector" || name === "propose_custom_mcp") && input.origin !== "chat") continue;
		if ((SANDBOX_SHELL_TOOL_NAMES as readonly string[]).includes(name)) {
			const shell = name as SandboxShellToolName;
			if (!sandboxShellAllowedForOrigin(shell, input.origin) || sandboxShellBlocked(input.autonomy, shell)) continue;
		}
		if (SKILL_WRITE_TOOL_NAMES.has(name) && input.origin !== "chat") continue;
		add(tool);
	}
	add(SHOW_IMAGE_TOOL);
	if (input.attachments.present) {
		add(ATTACHMENT_READ_TOOL);
		add(ATTACHMENT_LIST_TOOL);
		if (input.sandboxEnabled) add(ATTACHMENT_TO_COMPUTER_TOOL);
	}
	if (input.origin === "chat" && decideAction(input.autonomy, { actionClass: "write", tool: "generate_image", host: false }) !== "block") add(GENERATE_IMAGE_TOOL);
	add(CREATE_FILE_TOOL);
	if (input.userId !== "default") {
		add(INSPECT_PRESENTATION_TOOL);
		const routinePage = input.origin === "routine" && Boolean(input.routinePageId);
		if (input.origin === "chat" || routinePage) {
			for (const tool of PAGE_TOOLS) {
				if (routinePage && tool.function.name !== PAGE_UPDATE_TOOL_NAME && tool.function.name !== PAGE_READ_TOOL_NAME) continue;
				add(tool);
			}
		}
		if (loadCodeRunnerConfig().enabled) add(RUN_CODE_TOOL);
		if (input.origin === "chat") add(PROPOSE_API_CONNECTION_TOOL);
	}
	if (input.apiConnector) {
		add(API_SEARCH_TOOL);
		add(API_CALL_TOOL);
	}
	for (const tool of emailToolsFor(input.email)) add(tool);
	if (shouldExposeTaskList({ origin: input.origin, isSubagent: false })) add(UPDATE_TASK_LIST_TOOL);
	if (input.setEngine && !input.helper) add(SET_ENGINE_TOOL);
	// Proativo, push avulso e alerta: as mesmas tools e condições do v1 (núcleo, nunca adiadas), fora dos ajudantes.
	if (!input.helper) {
		if (input.proactive) for (const tool of proactiveToolsFor({ origin: input.origin, hasConversation: input.proactive.hasConversation })) add(tool);
		if (input.userPush && (input.origin === "routine" || input.origin === "chat")) add(notifyUserPushTool(input.userPush));
		if (input.alertRun && input.origin === "routine") add(REPORT_ALERT_TOOL);
	}
	const botCount = input.botMessaging?.botCount ?? 0;
	if (!input.helper && shouldExposeSendToBot({ origin: input.origin, botCount })) add(SEND_TO_BOT_TOOL);
	if (!input.helper && shouldExposeDecideBotPending({ origin: input.origin, botCount, enabled: input.botMessaging?.decideForOtherBots === true })) add(DECIDE_BOT_PENDING_TOOL);
	if (input.helper) {
		add(NOTEBOOK_WRITE_TOOL);
	} else if (input.longWork) {
		add(NOTEBOOK_WRITE_TOOL);
		add(NOTEBOOK_READ_TOOL);
		if (input.helpers) add(DELEGATE_V2_TOOL);
	}

	// Dica de pré-carga (nunca portão): grupos que o pedido sugere já vão carregados; o resto carrega por busca.
	const routerText = economyRouterText({ origin: input.origin, objective: input.objective, messages: input.routerMessages, lastUserMessage: input.lastUserMessage });
	const preloaded = routeContextGroups({
		text: routerText,
		hasImageAttachments: input.hasImageAttachments,
		profileAllowed: input.allowProfileUpdate,
	});
	if (input.allowProfileUpdate) preloaded.add("profile");
	if (input.origin === "routine" && input.routinePageId) preloaded.add("pages");
	// Trabalho longo termina em documento: `create_file` já vai carregado (sem o passo extra de carga na entrega).
	if (input.longWork && !input.helper && native.some((tool) => tool.function.name === "create_file")) preloaded.add("files");
	if (!native.some((tool) => tool.function.name === "propose_bot")) preloaded.delete("bots");
	// Run de e-mail recebido: o procedimento anti-manipulação do e-mail já vai no 1º passo (igual ao v1).
	if (input.origin === "email") preloaded.add("email");
	if (!native.some((tool) => tool.function.name.startsWith("email_"))) preloaded.delete("email");
	for (const name of input.priorLoadedTools ?? []) {
		const group = planNativeTools(native, new Set()).deferred.get(name)?.group;
		if (group) preloaded.add(group);
	}
	const plan = planNativeTools(native, preloaded);

	const mcp = input.mcp;
	const mcpTools = (mcp?.toolset.tools ?? []).filter((tool) => {
		const entry = mcp?.toolset.entries.get(tool.function.name);
		if (!entry || !allow(tool.function.name)) return false;
		const decision = decideAction(input.autonomy, entry.autonomyMeta);
		if (decision === "block") return false;
		// Sem humano para aprovar (rotina, webhook): só o que a autonomia libera sem perguntar.
		return !isUnattendedOrigin(input.origin) || decision === "allow";
	});
	const wantsSearch = allow("mcp_tool_search") && (plan.deferred.size > 0 || Boolean(mcp?.toolset.deferred));
	const tools = orderEconomyTools({ plan, searchTool: wantsSearch ? TOOL_SEARCH_WITH_BUILTINS : null, connectorTools: mcpTools });
	const promptedGroups = new Set<ContextGroup>(preloaded);
	const deferral = plan.deferred.size > 0 ? createNativeDeferral({ deferred: plan.deferred, tools, promptedGroups }) : null;

	let mcpActiveOrder: string[] = mcpTools.map((tool) => tool.function.name);
	const mcpUsed = new Set<string>();
	const activateMcpTools = (names: string[]) => {
		const allowed = names.filter(allow);
		if (!mcp || allowed.length === 0) return { activated: [], evicted: [] };
		const activation = planMcpActivation({
			namesToActivate: allowed,
			available: mcp.toolset.available,
			activeOrder: mcpActiveOrder,
			maxTools: MCP_MAX_EXPOSED_TOOLS,
			maxJsonChars: MCP_MAX_TOOLS_JSON_CHARS,
			pinned: [...mcpUsed],
		});
		for (const evicted of activation.evicted) {
			const at = tools.findIndex((tool) => tool.function.name === evicted);
			if (at !== -1) tools.splice(at, 1);
		}
		for (const name of activation.activated) {
			const tool = mcp.toolset.available.get(name);
			if (tool) tools.push(tool);
		}
		mcpActiveOrder = activation.finalOrder;
		return { activated: activation.activated, evicted: activation.evicted };
	};
	return {
		tools,
		deferral,
		index: wantsSearch ? deferredToolsIndex(native, preloaded) : "",
		preloaded,
		promptedGroups,
		activateMcpTools,
		activeMcpTools: () => [...mcpActiveOrder],
		pinMcpTool: (name) => {
			mcpUsed.add(name);
		},
	};
}
