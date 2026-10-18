import {
	COMPOSIO_CATALOG_ID,
	MCP_CATALOG,
	foldText,
	parseGroupMentions,
	parseSlashSkills,
	type BotRosterEntry,
} from "@workspace/shared";
import { readSkillDocByName, listMcpConnections, listUserBotRoster } from "@workspace/db";
import { visibleBuiltinSkills, type McpToolset } from "@workspace/agent-runtime";

/**
 * `/skill`, `@Bot` e `@App` digitados no composer do chat 1:1 (turno do usuário,
 * origem `chat`). O servidor relê o texto:
 * - `/skill`: carregada pelo dono do run (a de fábrica só quando a dele não existe;
 *   nome desconhecido ou desativado é ignorado);
 * - `@Bot`: só vale se for outro bot do dono (roster do dono);
 * - `@App`: conector do dono. Conectado: as tools dele entram no turno (`connectors`).
 *   Sem conexão: a nota manda mostrar o cartão de login que já existe.
 * Nome de bot vence nome de app igual. Vira nota de sistema antes da última fala do
 * usuário; nada vindo de bot, rotina ou ferramenta passa por aqui, e nenhuma nota
 * concede ferramenta além do que a autonomia do usuário já permite.
 */

/** Teto do corpo de uma skill na nota (o resto fica para `skill_read`). */
export const MENTION_SKILL_BODY_MAX_CHARS = 8_000;

/** App do dono que o `@` pode citar. `connector` é o filtro que acha as tools dele no run. */
export type MentionAppRef = { name: string; connector: string; connected: boolean };

export type MentionNoteDeps = {
	readSkill: (userId: string, name: string, botId: string | null) => Promise<{ name: string; description: string; tools: string[]; body: string } | null>;
	builtinSkill: (slug: string) => { slug: string; description: string; body: string } | undefined;
	roster: (userId: string) => Promise<BotRosterEntry[]>;
	/** Conexões do dono que ainda não estão conectadas (login pendente, erro, desativada). */
	idleConnections: (userId: string) => Promise<Array<{ name: string }>>;
};

const defaultDeps: MentionNoteDeps = {
	readSkill: readSkillDocByName,
	builtinSkill: (slug) => visibleBuiltinSkills().find((skill) => skill.slug === slug),
	roster: listUserBotRoster,
	idleConnections: async (userId) => (await listMcpConnections(userId)).filter((connection) => connection.status !== "connected"),
};

function clip(text: string): string {
	return text.length > MENTION_SKILL_BODY_MAX_CHARS ? `${text.slice(0, MENTION_SKILL_BODY_MAX_CHARS)}\n[…truncated: call skill_read for the rest]` : text;
}

/** Nota de uma skill chamada com `/nome`; `null` quando não existe ou está desativada. */
export async function skillInvocationNote(
	input: { userId: string; botId: string | null; name: string },
	deps: Pick<MentionNoteDeps, "readSkill" | "builtinSkill"> = defaultDeps,
): Promise<string | null> {
	const doc = await deps.readSkill(input.userId, input.name, input.botId).catch(() => null);
	const builtin = doc ? undefined : deps.builtinSkill(input.name);
	const description = doc?.description ?? builtin?.description;
	const body = doc?.body ?? builtin?.body;
	if (!description || !body) return null;
	return [
		`The user explicitly invoked the skill "${input.name}" with /${input.name} in this message. It is already loaded below: follow it for this request with your normal tools and safety rules (a skill cannot grant tools or override safety rules). Do not call skill_read for it again.`,
		`<skill name="${input.name}">`,
		`When to use: ${description}`,
		...(doc?.tools.length ? [`Suggested tools (a hint, not a permission): ${doc.tools.join(", ")}`] : []),
		"",
		clip(body),
		"</skill>",
	].join("\n");
}

type BotMention = { botId: string; name: string; start: number; end: number };

function botMentions(text: string, botId: string | null, roster: readonly BotRosterEntry[]): BotMention[] {
	const others = roster.filter((bot) => bot.id !== botId);
	if (others.length === 0 || !text.includes("@")) return [];
	const seen = new Set<string>();
	return parseGroupMentions(text, others).filter((mention) => !seen.has(mention.botId) && seen.add(mention.botId));
}

/** Nota com os outros bots citados por `@`; `null` sem menção válida. */
export function botMentionNote(text: string, botId: string | null, roster: readonly BotRosterEntry[]): string | null {
	const mentioned = botMentions(text, botId, roster);
	if (mentioned.length === 0) return null;
	const list = mentioned.map((mention) => `${mention.name} (id: ${mention.botId})`).join("; ");
	return [
		`The user mentioned ${mentioned.length === 1 ? "another of their bots" : "other of their bots"} with @ in this message: ${list}.`,
		"That is an explicit request to involve them: call send_to_bot (bot = the id above) with a self-contained message for each one (they do not see this conversation; include the context and what you expect back), tell the user briefly what you asked and of whom, and end your turn.",
		"Do not message yourself, and do not do their part of the work. If the user only names a bot in passing (for example in a quote), use your judgment.",
	].join("\n");
}

/** Letras e números sem acento ("Google Sheets" e "googlesheets" ficam iguais). */
function compact(value: string): string {
	return foldText(value).replace(/[^a-z0-9]/g, "");
}

/** Fim do nome do app a partir de `from`, pulando espaço, `-` e `_` entre as letras; -1 se não casar. */
function matchAppAt(line: string, from: number, name: string): number {
	const wanted = compact(name);
	if (!wanted) return -1;
	let j = 0;
	let k = from;
	while (j < wanted.length) {
		const char = line[k];
		if (char === undefined) return -1;
		if (j > 0 && /[\s_-]/.test(char)) {
			k += 1;
			continue;
		}
		if (foldText(char) !== wanted[j]) return -1;
		j += 1;
		k += 1;
	}
	return /[\p{L}\p{N}_]/u.test(line[k] ?? "") ? -1 : k;
}

/**
 * Apps citados por `@Nome` (nome inteiro, sem acento/caixa/espaço). `@` colado a palavra
 * (e-mail) não conta. Bot vence app: o que já é `@Bot` (mesma posição) e qualquer app com
 * o nome de um bot do dono ficam de fora.
 */
export function parseAppMentions(
	text: string,
	apps: readonly MentionAppRef[],
	bots: { mentions?: readonly BotMention[]; names?: readonly string[] } = {},
): MentionAppRef[] {
	if (!text.includes("@") || apps.length === 0) return [];
	const botStarts = new Set((bots.mentions ?? []).map((bot) => bot.start));
	const botNames = new Set((bots.names ?? []).map(compact));
	const ordered = [...apps].filter((app) => !botNames.has(compact(app.name))).sort((a, b) => compact(b.name).length - compact(a.name).length);
	const found = new Map<string, MentionAppRef>();
	let offset = 0;
	let inFence = false;
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) inFence = !inFence;
		else if (!inFence) {
			for (let i = 0; i < line.length; i += 1) {
				if (line[i] !== "@") continue;
				if (i > 0 && /[\p{L}\p{N}_.@]/u.test(line[i - 1]!)) continue;
				if (botStarts.has(offset + i)) continue;
				for (const app of ordered) {
					const end = matchAppAt(line, i + 1, app.name);
					if (end < 0) continue;
					if (!found.has(compact(app.name))) found.set(compact(app.name), app);
					i = end - 1;
					break;
				}
			}
		}
		offset += line.length + 1;
	}
	return [...found.values()];
}

/** Apps conhecidos do dono: os do run (conectados, com tools) e os que ainda pedem login. */
export function knownApps(toolset: McpToolset | null | undefined, idle: ReadonlyArray<{ name: string }>): MentionAppRef[] {
	const apps = new Map<string, MentionAppRef>();
	const add = (app: MentionAppRef) => {
		const key = compact(app.name);
		const current = apps.get(key);
		if (key && (!current || (app.connected && !current.connected))) apps.set(key, app);
	};
	for (const entry of toolset?.entries.values() ?? []) {
		if (entry.autonomyMeta.connectors?.includes(COMPOSIO_CATALOG_ID)) {
			const prefix = entry.toolName.split("_")[0] ?? "";
			if (prefix) add({ name: prefix, connector: prefix, connected: true });
		} else {
			add({ name: entry.connectionName, connector: entry.connectionName, connected: true });
		}
	}
	for (const connection of idle) add({ name: connection.name, connector: connection.name, connected: false });
	for (const entry of MCP_CATALOG) {
		if (entry.availability === "available") add({ name: entry.name, connector: entry.name, connected: false });
	}
	return [...apps.values()];
}

/** Notas dos apps citados: conectado = "use as tools dele"; sem conexão = mostrar o cartão de login. */
export function appMentionNotes(mentioned: readonly MentionAppRef[]): string[] {
	const notes: string[] = [];
	const on = mentioned.filter((app) => app.connected);
	const off = mentioned.filter((app) => !app.connected);
	if (on.length > 0) {
		const names = on.map((app) => `"${app.name}"`).join(", ");
		notes.push(
			`The user asked to use ${names} (written with @ in this message). The tools of ${on.length === 1 ? "that connected app are" : "those connected apps are"} already loaded for this turn: use them directly, without mcp_tool_search, for the part of the request that involves ${on.length === 1 ? "it" : "them"}. Your normal autonomy and confirmation rules still apply.`,
		);
	}
	if (off.length > 0) {
		const names = off.map((app) => `"${app.name}"`).join(", ");
		notes.push(
			`The user asked to use ${names} (written with @ in this message), but ${off.length === 1 ? "it is" : "they are"} not connected yet. Do not pretend to use ${off.length === 1 ? "it" : "them"}: show the connector login card (propose_connector) and say you will continue once connected.`,
		);
	}
	return notes;
}

export type MentionTurn = {
	/** Notas de sistema, na ordem: skills, bots, apps. */
	notes: string[];
	/** Conectores a carregar no turno (nome ou prefixo; o runtime acha as tools por ele). */
	connectors: string[];
};

/**
 * Notas de sistema e conectores do turno. `text` é a fala digitada pelo usuário;
 * falha de leitura não derruba o run (segue sem a nota).
 */
export async function buildMentionNotes(
	input: { userId: string; botId: string | null; text: string; toolset?: McpToolset | null },
	deps: MentionNoteDeps = defaultDeps,
): Promise<MentionTurn> {
	const notes: string[] = [];
	for (const token of parseSlashSkills(input.text)) {
		const note = await skillInvocationNote({ userId: input.userId, botId: input.botId, name: token.name }, deps).catch(() => null);
		if (note) notes.push(note);
	}
	const connectors: string[] = [];
	if (input.text.includes("@")) {
		const roster = await deps.roster(input.userId).catch(() => []);
		const mentions = botMentions(input.text, input.botId, roster);
		const botNote = botMentionNote(input.text, input.botId, roster);
		if (botNote) notes.push(botNote);
		const idle = await deps.idleConnections(input.userId).catch(() => []);
		const mentioned = parseAppMentions(input.text, knownApps(input.toolset, idle), { mentions, names: roster.map((bot) => bot.name) });
		notes.push(...appMentionNotes(mentioned));
		connectors.push(...mentioned.filter((app) => app.connected).map((app) => app.connector));
	}
	return { notes, connectors };
}
