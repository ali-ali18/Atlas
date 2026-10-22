import type { ChatTool } from "@workspace/llm";
import { routeContextGroups } from "./intent-router.js";
import {
	deferredToolsIndex,
	isNativeToolGroup,
	nativeToolGroupOf,
	planNativeTools,
	type NativeToolPlan,
} from "./native-tools.js";
import type { ContextGroup } from "./prompt-blocks.js";

/**
 * Plano de economia de contexto do 1º passo (L5): quais grupos entram já, quais
 * tools nativas ficam adiadas e o índice que o prompt mostra. Puro: o runtime
 * só aplica o resultado.
 */
export type ContextEconomyPlan = {
	/** Grupos pré-carregados (tools e procedimento no prompt). */
	groups: Set<ContextGroup>;
	plan: NativeToolPlan;
	/** Índice do prompt das tools adiadas ("" quando não há o que adiar). */
	index: string;
};

/**
 * Texto que o roteador de intenção lê. Só a última fala do usuário perdia o
 * contexto: numa retomada ("continue", "sim") ou num pedido sem palavra-chave
 * ("faça a proposta no Bling"), o navegador/rotina do turno anterior sumia. Por
 * isso soma o objetivo do run (o pedido original) e a fala anterior do usuário.
 * Rotina lê só o objetivo (não há conversa).
 */
export function economyRouterText(input: {
	origin?: string;
	objective?: string;
	messages: ReadonlyArray<{ role: string; content?: unknown }>;
	lastUserMessage: string;
}): string {
	if (input.origin === "routine") return input.objective ?? input.lastUserMessage;
	const userTexts = input.messages
		.filter((message) => message.role === "user" && typeof message.content === "string")
		.map((message) => message.content as string);
	const previous = userTexts.length >= 2 ? userTexts[userTexts.length - 2]! : "";
	return [input.lastUserMessage, input.objective ?? "", previous].filter(Boolean).join("\n");
}

/** O texto do pedido cita (pelo nome ou domínio) alguma API conectada? */
export function apiMentioned(connections: ReadonlyArray<{ name: string; slug: string; domain: string }>, text: string): boolean {
	const plain = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
	return connections.some((item) => [item.name, item.slug, item.domain.split(".").slice(-3, -1).join(".")].some((word) => word.length >= 3 && plain.includes(word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase())));
}

/** Tool de usos condicionais que fica no fim do array (não entra no prefixo estável). */
const TAIL_TOOLS: ReadonlySet<string> = new Set(["set_autonomy", "set_primary_bot"]);

export function planContextEconomy(input: {
	/** Tools nativas já filtradas (origem, autonomia, toolFilter, perfil). */
	eligible: readonly ChatTool[];
	/** Texto que o roteador lê (ver `economyRouterText`). */
	routerText: string;
	/** Onboarding do bot ainda não terminou: a tool de perfil precisa estar à mão. */
	onboardingIncomplete?: boolean;
	/** Evento de config do bot, onboarding ou resposta de questionário de onboarding. */
	onboarding: boolean;
	hasImageAttachments: boolean;
	profileAllowed: boolean;
	/** O usuário pediu mudar o bot explicitamente. */
	profileRequested: boolean;
	/** Nomes de tools já carregadas numa execução anterior (retomada de checkpoint). */
	resumedToolNames?: readonly string[];
	/** V6: o run tem sandbox. O grupo browser já vai no 1º passo: o modelo não gasta a decisão 0 em `mcp_tool_search`. */
	preloadBrowser?: boolean;
	/** O dono tem logins de site no cofre: o grupo vault (login_fill, secret_list) já vai no 1º passo. */
	preloadVault?: boolean;
	/** O pedido cita uma API conectada: o grupo api (api_search, api_call) já vai no 1º passo. */
	preloadApi?: boolean;
	/** Run disparado por e-mail recebido: o grupo email já vai no 1º passo (procedimento anti-manipulação incluso). */
	preloadEmail?: boolean;
	/** Rotina que atualiza uma página: as tools `page_*` já vão no 1º passo (o texto do turno não precisa citar "painel"). */
	preloadPages?: boolean;
}): ContextEconomyPlan {
	const groups = routeContextGroups({
		text: input.routerText,
		onboarding: input.onboarding,
		hasImageAttachments: input.hasImageAttachments,
		profileAllowed: input.profileAllowed,
	});
	if ((input.profileRequested || input.onboardingIncomplete) && input.profileAllowed) groups.add("profile");
	// Sem a tool (rotina, webhook, conversa entre bots) o procedimento de "novo agente" é só ruído.
	if (!input.eligible.some((tool) => tool.function.name === "propose_bot")) groups.delete("bots");
	if (input.preloadBrowser) groups.add("browser");
	if (input.preloadVault) groups.add("vault");
	if (input.preloadApi) groups.add("api");
	if (input.preloadPages) groups.add("pages");
	// Sem as tools (bot sem e-mail) o procedimento de e-mail é só ruído.
	if (!input.eligible.some((tool) => tool.function.name.startsWith("email_"))) groups.delete("email");
	else if (input.preloadEmail) groups.add("email");
	for (const name of input.resumedToolNames ?? []) {
		const group = nativeToolGroupOf(name);
		if (group && isNativeToolGroup(group)) groups.add(group);
	}
	const plan = planNativeTools(input.eligible, groups);
	return { groups, plan, index: deferredToolsIndex(input.eligible, groups) };
}

/**
 * Ordem final do array de tools do 1º passo: núcleo, busca sob demanda, tools
 * de conector (ordem por nome, não pela do banco), grupos pré-carregados e, por
 * último, as condicionais. Quem carrega depois entra no fim, sem reordenar.
 */
export function orderEconomyTools(input: {
	plan: NativeToolPlan;
	searchTool: ChatTool | null;
	connectorTools: readonly ChatTool[];
}): ChatTool[] {
	const core = input.plan.core.filter((tool) => !TAIL_TOOLS.has(tool.function.name));
	const tail = input.plan.core.filter((tool) => TAIL_TOOLS.has(tool.function.name));
	const connectors = [...input.connectorTools].sort((a, b) => a.function.name.localeCompare(b.function.name));
	return [...core, ...(input.searchTool ? [input.searchTool] : []), ...connectors, ...input.plan.preloaded, ...tail];
}
