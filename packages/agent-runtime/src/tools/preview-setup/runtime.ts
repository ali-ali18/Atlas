import {
	DEV_APPROVAL_TTL_MS, deletePreviewSetup, findExecutedConfirmCall, getPreviewSetup, getSkillPendingIntent, isOwnerUserId, loadPreviewSetup, persistConversationCardFromEvent, savePreviewSetup, saveSkillPendingIntent,
} from "@workspace/db";
import { SETUP_SECRET_DNS_TOKEN, normalizePreviewBaseDomain } from "@workspace/shared";
import { getVaultService } from "../../secrets/vault-service.js";
import { defaultChecks } from "./checks.js";
import { cloudflareProvider, desecProvider, type FetchFn } from "./dns.js";
import type { SetupDeps } from "./machine.js";
import type { PreviewSetupToolContext } from "./tool.js";

/**
 * Liga a máquina de passos ao runtime real: estado no banco (por dono), token no cofre do dono, cartão de
 * aprovação (intenção `infra-setup`) e verificações de rede. Tudo substituível em teste.
 */

const realFetch: FetchFn = (url, init) => fetch(url, init);

/** Quem é administrador muda raramente: uma consulta por usuário a cada 10 min por processo (o "Bom dia" não bate no banco toda vez). */
const OWNER_TTL_MS = 10 * 60_000;
const ownerCache = new Map<string, { value: boolean; at: number }>();
export function clearOwnerCache(): void {
	ownerCache.clear();
}
export async function cachedIsOwner(userId: string, env: NodeJS.ProcessEnv, lookup: typeof isOwnerUserId = isOwnerUserId, now: () => number = Date.now): Promise<boolean> {
	// Sem ATLAS_OWNER_EMAIL ninguém é administrador: nem consulta.
	if (!env.ATLAS_OWNER_EMAIL?.trim()) return false;
	const key = `${userId}|${env.ATLAS_OWNER_EMAIL.trim().toLowerCase()}`;
	const hit = ownerCache.get(key);
	if (hit && now() - hit.at < OWNER_TTL_MS) return hit.value;
	const value = await lookup(userId, env);
	ownerCache.set(key, { value, at: now() });
	return value;
}

/**
 * Id do cartão: `confirm-<chave>-<runId>`. O último trecho TEM de ser o run que pediu (`askingRunId` em
 * `apps/api/src/chat/confirmed-action.ts` lê o último `-`); assim o desfecho vira o resultado da chamada que parou.
 */
export function setupConfirmId(runId: string | undefined, callKey: string): string {
	return `confirm-${callKey.slice(0, 8)}-${runId ?? "local"}`;
}

export function createPreviewSetupContext(input: {
	userId: string;
	conversationId: string;
	botId?: string;
	runId?: string;
	env?: NodeJS.ProcessEnv;
	overrides?: Partial<SetupDeps> & { isAdmin?: () => Promise<boolean> };
}): PreviewSetupToolContext {
	const env = input.env ?? process.env;
	const { isAdmin, ...overrides } = input.overrides ?? {};
	const deps: SetupDeps = {
		userId: input.userId,
		atlasUrl: env.ATLAS_URL?.trim() ?? "",
		webUrls: [env.ATLAS_PUBLIC_URL, env.BETTER_AUTH_URL],
		now: () => new Date(),
		loadState: () => getPreviewSetup(input.userId),
		saveState: (state) => savePreviewSetup(input.userId, state),
		deleteState: () => deletePreviewSetup(input.userId),
		stateIsCorrupt: async () => (await loadPreviewSetup(input.userId)).kind === "corrupt",
		isApprovalPending: async (callKey) => {
			const pending = await getSkillPendingIntent(input.userId, input.conversationId).catch(() => null);
			return pending?.payload.action === "infra-setup" && pending.payload.infraSetup?.callKey === callKey;
		},
		getDnsToken: async () => {
			const resolved = await getVaultService().resolveRef(input.userId, { kind: "secret", name: SETUP_SECRET_DNS_TOKEN, raw: "" }, { actor: "bot", botId: input.botId, conversationId: input.conversationId, detail: "preview_setup" }).catch(() => null);
			return resolved?.value ?? null;
		},
		providerFor: (id, token) => (id === "cloudflare" ? cloudflareProvider(token, realFetch) : desecProvider(token, realFetch)),
		checks: defaultChecks(),
		findApproved: async (callKey) => (await findExecutedConfirmCall(input.conversationId, callKey, DEV_APPROVAL_TTL_MS).catch(() => null))?.ok === true,
		requestApproval: async ({ callKey, title, description }) => {
			const confirmId = setupConfirmId(input.runId, callKey);
			await saveSkillPendingIntent({
				userId: input.userId,
				conversationId: input.conversationId,
				ttlMs: DEV_APPROVAL_TTL_MS,
				payload: { kind: "confirm", action: "infra-setup", confirmId, botId: input.botId, infraSetup: { callKey, label: title.replace(/\?$/, "").toLowerCase() } },
			});
			const card = { type: "confirm" as const, confirmId, title, description, confirmLabel: "Confirmar", cancelLabel: "Agora não", callKey };
			await persistConversationCardFromEvent(input.conversationId, card).catch(() => undefined);
			return card;
		},
		envApplied: (domain) => normalizePreviewBaseDomain(env.ATLAS_PREVIEW_BASE_DOMAIN) === domain,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		...overrides,
	};
	return { isAdmin: isAdmin ?? (() => cachedIsOwner(input.userId, env)), deps };
}
