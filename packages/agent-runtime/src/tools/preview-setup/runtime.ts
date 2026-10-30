import {
	DEV_APPROVAL_TTL_MS, deletePreviewSetup, findExecutedConfirmCall, getPreviewSetup, isOwnerUserId, persistConversationCardFromEvent, savePreviewSetup, saveSkillPendingIntent,
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
		now: () => new Date(),
		loadState: () => getPreviewSetup(input.userId),
		saveState: (state) => savePreviewSetup(input.userId, state),
		deleteState: () => deletePreviewSetup(input.userId),
		getDnsToken: async () => {
			const resolved = await getVaultService().resolveRef(input.userId, { kind: "secret", name: SETUP_SECRET_DNS_TOKEN, raw: "" }, { actor: "bot", botId: input.botId, conversationId: input.conversationId, detail: "preview_setup" }).catch(() => null);
			return resolved?.value ?? null;
		},
		providerFor: (id, token) => (id === "cloudflare" ? cloudflareProvider(token, realFetch) : desecProvider(token, realFetch)),
		checks: defaultChecks(),
		findApproved: async (callKey) => (await findExecutedConfirmCall(input.conversationId, callKey, DEV_APPROVAL_TTL_MS).catch(() => null))?.ok === true,
		requestApproval: async ({ callKey, title, description }) => {
			const confirmId = `confirm-${input.runId ?? "local"}-${callKey.slice(0, 8)}`;
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
	return { isAdmin: isAdmin ?? (() => isOwnerUserId(input.userId, env)), deps };
}
