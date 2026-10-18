import { hostOf, registrableDomain } from "@workspace/shared";
import type { McpToolEntry } from "../mcp/registry.js";
import type { McpRuntime } from "../mcp/runtime.js";

/**
 * Código de login por e-mail. Depois de preencher o login do Cofre, se o site
 * pede um código enviado por e-mail e o usuário tem um conector de e-mail
 * (Gmail nativo, Composio ou MCP com ferramentas de leitura), o runtime procura
 * a mensagem, extrai o código e o digita na página. O conteúdo do e-mail e o
 * código nunca voltam ao modelo. Só ferramentas de leitura: nada é marcado como
 * lido nem apagado.
 */

export type EmailMessage = { id?: string; from: string; subject: string; body: string; at?: number };

export type EmailSource = {
	/** Nome do conector para o card ("Gmail"). */
	name: string;
	search: (query: { domains: string[]; sinceMs: number }) => Promise<EmailMessage[]>;
};

/** Domínios de envio conhecidos por site (além da regra "domínio do remetente contém o nome do site"). */
const KNOWN_SENDERS: Record<string, string[]> = {
	"chatgpt.com": ["openai.com", "tm.openai.com", "chatgpt.com"],
	"openai.com": ["openai.com", "tm.openai.com"],
	"github.com": ["github.com"],
	"google.com": ["google.com"],
	"microsoft.com": ["microsoft.com", "microsoftonline.com"],
	"notion.so": ["notion.so", "makenotion.com"],
	"x.com": ["x.com", "twitter.com"],
};

export function senderDomainsFor(siteHost: string): string[] {
	const site = registrableDomain(siteHost.replace(/^www\./, ""));
	return [...new Set([site, ...(KNOWN_SENDERS[site] ?? [])])];
}

/** O remetente é do site: mesmo domínio registrável, domínio de envio conhecido, ou o nome do site aparece no domínio do remetente. */
export function senderAllowed(from: string, siteHost: string): boolean {
	const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
	const host = address.includes("@") ? address.split("@").pop()!.trim().toLowerCase() : "";
	if (!host) return false;
	const sender = registrableDomain(host);
	const site = registrableDomain(siteHost.replace(/^www\./, ""));
	if (sender === site) return true;
	if ((KNOWN_SENDERS[site] ?? []).some((known) => registrableDomain(known) === sender)) return true;
	const label = site.split(".")[0] ?? "";
	return label.length >= 4 && sender.split(".")[0]!.includes(label);
}

const CODE_PATTERNS: RegExp[] = [
	/\b(?:code|c[oó]digo|verification|verifica[cç][aã]o|otp|pin)\b[^\n\d]{0,40}?(\d{4,8})\b/i,
	/\b(\d{4,8})\b[^\n\d]{0,30}(?:is your|is the|[eé] o seu|[eé] seu)/i,
];

/** Código de 4 a 8 dígitos (ou alfanumérico de 6 a 8 com dígito) perto de "code/código/verification". */
export function extractLoginCode(text: string): string | null {
	for (const pattern of CODE_PATTERNS) {
		const found = pattern.exec(text)?.[1];
		if (found) return found;
	}
	const alnum = /\b(?:code|c[oó]digo)\b[^\n\w]{0,10}([A-Z0-9]{6,8})\b/i.exec(text)?.[1];
	return alnum && /\d/.test(alnum) ? alnum : null;
}

export type CodeSearchDeps = {
	source: EmailSource;
	siteHost: string;
	/** Início do login: só mensagens recebidas depois (com folga de 1 min). */
	startedAtMs: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	timeoutMs?: number;
	intervalMs?: number;
};

const WINDOW_SLACK_MS = 60_000;
const MAX_AGE_MS = 10 * 60_000;

/** Procura o código por até ~60 s (o e-mail pode demorar). Devolve só o código. */
export async function fetchLoginEmailCode(deps: CodeSearchDeps): Promise<string | null> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const deadline = now() + (deps.timeoutMs ?? 60_000);
	const sinceMs = deps.startedAtMs - WINDOW_SLACK_MS;
	for (;;) {
		try {
			const messages = await deps.source.search({ domains: senderDomainsFor(deps.siteHost), sinceMs });
			// Mais recente primeiro.
			for (const message of [...messages].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))) {
				if (!senderAllowed(message.from, deps.siteHost)) continue;
				if (message.at !== undefined && (message.at < sinceMs || now() - message.at > MAX_AGE_MS)) continue;
				const code = extractLoginCode(`${message.subject}\n${message.body}`);
				if (code) return code;
			}
		} catch {
			// conector fora do ar: tenta de novo até o prazo
		}
		if (now() >= deadline) return null;
		await sleep(deps.intervalMs ?? 5_000);
	}
}

// ---------- descoberta do conector de e-mail e leitura ----------

type Entry = McpToolEntry;

const MAIL_NAME = /(gmail|outlook|mail|inbox|message)/i;
const SEARCH_TOOL = /(search|list|fetch|find|query)[_a-z]*(mail|message|email|inbox)|(mail|message|email)s?[_a-z]*(search|list|fetch)/i;
const READ_TOOL = /(read|get)[_a-z]*(message|mail|email)/i;

function plainToolName(toolName: string): string {
	return toolName.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
}

function arrayItems(value: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
	if (Array.isArray(value)) {
		for (const item of value) {
			if (item && typeof item === "object" && !Array.isArray(item)) {
				const row = item as Record<string, unknown>;
				if ("subject" in row || "from" in row || "sender" in row || "snippet" in row) out.push(row);
				else arrayItems(row, out);
			}
		}
	} else if (value && typeof value === "object") {
		for (const child of Object.values(value as Record<string, unknown>)) arrayItems(child, out);
	}
	return out;
}

const str = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (value && typeof value === "object") {
		const row = value as Record<string, unknown>;
		const nested = (row.emailAddress ?? row) as Record<string, unknown>;
		return [nested.name, nested.address ? `<${nested.address}>` : ""].filter(Boolean).join(" ");
	}
	return "";
};

function parseDate(value: unknown): number | undefined {
	if (typeof value === "number") return value > 1e12 ? value : value * 1000;
	if (typeof value === "string" && value) {
		if (/^\d{12,}$/.test(value)) return Number(value);
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

/** Resultado de uma ferramenta de e-mail (JSON ou texto "de:/assunto:/data:") vira mensagens. */
export function parseEmailResult(text: string): EmailMessage[] {
	try {
		const json = JSON.parse(text) as unknown;
		return arrayItems(json).map((row) => ({
			id: typeof row.id === "string" ? row.id : typeof row.messageId === "string" ? row.messageId : undefined,
			from: str(row.from ?? row.sender ?? row.From),
			subject: str(row.subject ?? row.Subject),
			body: str(row.messageText ?? row.body ?? row.bodyPreview ?? row.snippet ?? row.preview ?? row.text),
			at: parseDate(row.date ?? row.internalDate ?? row.receivedDateTime ?? row.messageTimestamp ?? row.receivedAt),
		}));
	} catch {
		// segue para o formato de texto
	}
	const field = (block: string, name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(block)?.[1]?.trim() ?? "";
	return text
		.split(/\n{2,}(?=id:|De:)/)
		.map((block) => {
			const date = field(block, "(?:data|date)");
			return {
				id: field(block, "id") || undefined,
				from: field(block, "(?:de|from)"),
				subject: field(block, "(?:assunto|subject)"),
				body: field(block, "(?:resumo|snippet)") || block.split(/\n\n/).slice(1).join("\n"),
				at: parseDate(date),
			};
		})
		.filter((message) => message.from || message.subject);
}

/**
 * Primeiro conector de e-mail do usuário com ferramenta de busca/lista somente
 * leitura (Gmail nativo, Outlook ou qualquer MCP/Composio com esse formato).
 */
export function findEmailSource(mcp: McpRuntime | null | undefined, signal?: AbortSignal): EmailSource | null {
	if (!mcp) return null;
	let search: { name: string; entry: Entry } | null = null;
	let read: string | null = null;
	let connection = "";
	for (const [name, entry] of mcp.toolset.entries) {
		if (!entry.readOnly) continue;
		const plain = plainToolName(entry.toolName);
		const mailish = MAIL_NAME.test(entry.connectionName) || MAIL_NAME.test(plain);
		if (!mailish) continue;
		if (!search && (SEARCH_TOOL.test(plain) || (/gmail/i.test(entry.connectionName) && /^search/i.test(plain)))) {
			search = { name, entry };
			connection = entry.connectionName;
		}
	}
	if (!search) return null;
	for (const [name, entry] of mcp.toolset.entries) {
		if (entry.connectionId === search.entry.connectionId && entry.readOnly && READ_TOOL.test(plainToolName(entry.toolName))) read = name;
	}
	const props = Object.keys(mcp.toolset.available.get(search.name)?.function.parameters?.properties ?? {});
	const queryKey = ["query", "q", "search", "searchQuery"].find((key) => props.includes(key));
	if (!queryKey) return null;
	const limitKey = ["maxResults", "max_results", "limit", "top"].find((key) => props.includes(key));
	return {
		name: /gmail/i.test(connection) ? "Gmail" : /outlook|microsoft/i.test(connection) ? "Outlook" : connection.slice(0, 40) || "e-mail",
		search: async ({ domains, sinceMs }) => {
			const args: Record<string, unknown> = {
				[queryKey]: `from:(${domains.join(" OR ")}) after:${Math.floor(sinceMs / 1000)}`,
				...(limitKey ? { [limitKey]: 5 } : {}),
			};
			const result = await mcp.call(search!.name, args, signal);
			if (!result.ok) return [];
			const messages = parseEmailResult(result.text);
			// Resumo sem código: lê a mensagem inteira (só leitura).
			if (read) {
				for (const message of messages) {
					if (message.id && !extractLoginCode(`${message.subject}\n${message.body}`)) {
						const full = await mcp.call(read, { [/messageId/.test(JSON.stringify(mcp.toolset.available.get(read)?.function.parameters ?? {})) ? "messageId" : "id"]: message.id }, signal).catch(() => null);
						if (full?.ok) message.body = full.text.slice(0, 4000);
					}
				}
			}
			return messages;
		},
	};
}

/** Host do site a partir da URL da página (para a regra de remetente). */
export function siteHostOf(url: string): string {
	return hostOf(url) ?? "";
}
