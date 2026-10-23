import { findSecretRefs, hasSecretRef, replaceSecretRefs, type SecretRef } from "@workspace/shared";
import { createRedactor, type Redactor, type SecretEntry } from "./redact.js";
import { getVaultService, type VaultActor, type VaultService } from "./vault-service.js";

export class SecretRefError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SecretRefError";
	}
}

/**
 * Política de ferramentas de saída:
 *  - `mcp`: conectores do próprio usuário. O runtime MCP injeta o valor e redige o resultado;
 *  - `inject`: sandbox/sessão de código do usuário (a substituição acontece aqui);
 *  - `deny`: egress para domínio arbitrário ou conteúdo que vira artefato/mensagem — recusa;
 *  - `ignore`: o marcador segue literal (a ferramenta não envia nada para fora).
 */
export type SecretToolPolicy = "mcp" | "inject" | "deny" | "ignore";

const INJECT_TOOLS = new Set(["sandbox_shell", "shell", "shell_stdin", "write_file", "edit_file"]);
const DENY_TOOLS = new Set([
	"web_search",
	"web_extract",
	"navigate",
	"browser_snapshot",
	"browser_act",
	"browser_read",
	"browser_find",
	"browser_click",
	"browser_type",
	"browser_text",
	"browser_links",
	"browser_wait",
	"computer",
	"click",
	"type",
	"key",
	"generate_image",
	"show_image",
	"create_file",
	"send_to_bot",
	"notify_user",
	"report_alert",
	"delegate_task",
	"memory",
	"research_note",
	"propose_skill",
	"propose_skill_change",
	"propose_questionnaire",
	"propose_profile_update",
]);

export function secretToolPolicy(toolName: string): SecretToolPolicy {
	if (toolName.startsWith("mcp__")) return "mcp";
	if (INJECT_TOOLS.has(toolName)) return "inject";
	if (DENY_TOOLS.has(toolName)) return "deny";
	return "ignore";
}

const SECRET_REQUEST_HINT = "Se o valor não está no cofre, peça ao usuário com secret_request (o valor vai direto ao cofre, nunca pelo chat).";

function jsonEscaped(value: string): string {
	return JSON.stringify(value).slice(1, -1);
}

/** Troca os marcadores de uma string já resolvidos; valores com aspas/barra em strings JSON são escapados. */
function substitute(text: string, resolved: Map<string, string>): string {
	const jsonLike = /^\s*[[{]/.test(text);
	return replaceSecretRefs(text, (ref) => {
		const value = resolved.get(ref.raw);
		if (value === undefined) return undefined;
		return jsonLike && /["\\\u0000-\u001f]/.test(value) ? jsonEscaped(value) : value;
	});
}

export function collectRefs(value: unknown, into: SecretRef[] = []): SecretRef[] {
	if (typeof value === "string") into.push(...findSecretRefs(value));
	else if (Array.isArray(value)) for (const item of value) collectRefs(item, into);
	else if (value && typeof value === "object") for (const item of Object.values(value)) collectRefs(item, into);
	return into;
}

function mapStrings<T>(value: T, fn: (text: string) => string): T {
	if (typeof value === "string") return fn(value) as T;
	if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn)) as T;
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)])) as T;
	}
	return value;
}

/**
 * Resolve todos os marcadores de `args` (deep). Lança `SecretRefError` com texto
 * seguro (sem valores) se algum não existir.
 */
export async function injectSecretRefs(input: {
	userId: string;
	args: Record<string, unknown>;
	vault?: VaultService;
	by?: VaultActor;
}): Promise<{ args: Record<string, unknown>; entries: SecretEntry[]; refs: SecretRef[] }> {
	const refs = collectRefs(input.args);
	if (refs.length === 0) return { args: input.args, entries: [], refs };
	const vault = input.vault ?? getVaultService();
	const resolved = new Map<string, string>();
	const entries: SecretEntry[] = [];
	const missing: string[] = [];
	for (const ref of refs) {
		if (resolved.has(ref.raw)) continue;
		const secret = await vault.resolveRef(input.userId, ref, input.by);
		if (!secret) {
			missing.push(ref.raw);
			continue;
		}
		resolved.set(ref.raw, secret.value);
		entries.push({ value: secret.value, marker: secret.marker });
	}
	if (missing.length > 0) {
		throw new SecretRefError(`Segredo não encontrado no cofre: ${[...new Set(missing)].join(", ")}. ${SECRET_REQUEST_HINT} Para a rotina, use routine_webhook_info (se o segredo da rotina não estiver disponível, gere um novo segredo na rotina).`);
	}
	return { args: mapStrings(input.args, (text) => substitute(text, resolved)), entries, refs };
}

export type SecretSession = {
	readonly userId: string | undefined;
	/** Prepara os args de uma ferramenta de saída (injeta ou recusa conforme a política). */
	prepare: (toolName: string, args: Record<string, unknown>) => Promise<{ args: Record<string, unknown>; policy: SecretToolPolicy; refs: SecretRef[] }>;
	/** Garante a lista completa de valores do usuário e redige. */
	redact: <T>(value: T) => Promise<T>;
	redactor: Redactor;
};

export function createSecretSession(input: {
	userId?: string;
	vault?: VaultService;
	by?: () => VaultActor;
}): SecretSession {
	const redactor = createRedactor();
	let loaded: Promise<void> | null = null;
	const ensureLoaded = (): Promise<void> => {
		if (!input.userId) return Promise.resolve();
		loaded ??= (input.vault ?? getVaultService())
			.redactionEntries(input.userId)
			.then((entries) => redactor.add(entries))
			.catch(() => undefined);
		return loaded;
	};
	return {
		userId: input.userId,
		redactor,
		prepare: async (toolName, args) => {
			const policy = secretToolPolicy(toolName);
			if (!hasSecretRef(args)) return { args, policy, refs: [] };
			const refs = collectRefs(args);
			if (policy === "deny") {
				throw new SecretRefError(`Referências de segredo ({{secret:...}}, {{login:...}}) não podem ser usadas em "${toolName}": só ferramentas de saída confiáveis (conectores do usuário, sandbox) recebem o valor. Peça confirmação ao usuário ou use outra via.`);
			}
			if (policy === "ignore" || policy === "mcp" || !input.userId) return { args, policy, refs };
			await ensureLoaded();
			const injected = await injectSecretRefs({ userId: input.userId, args, vault: input.vault, by: input.by?.() });
			redactor.add(injected.entries);
			return { args: injected.args, policy, refs };
		},
		redact: async (value) => {
			await ensureLoaded();
			return redactor.deep(value);
		},
	};
}
