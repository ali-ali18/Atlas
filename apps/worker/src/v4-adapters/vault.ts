// Cofre do v4 no worker (F9): a porta `Vault` (nomes e metadados para o modelo; o valor só para o executor), o cartão
// "cadastre este segredo" e a fonte de login da VM. Tudo escopado pelo `userId` do RUN (40-seguranca): item de outro dono
// é indistinguível de item inexistente. NÃO importa o agent-runtime: a cripto vem de `@workspace/db/vault-crypto` e as
// linhas, de `@workspace/db`.
//
// O VALOR de um segredo simples só sai de `resolveSecret` (para o executor, que o redige da saída do run). A senha de um
// login só sai de `useLogin`, que o tratador `vault.login_fill` (sandbox-vault-login.ts) leva direto à VM. Nada disso
// vai a log, evento ou mensagem de erro: as falhas daqui têm texto fixo.
import type { SecretHandle, SecretRequests, VaultBackend } from "@workspace/agent";
import {
	appendUserSecretAudit,
	getUserSecretByName,
	getUserVaultKey,
	listUserSecrets,
	persistConversationCardFromEvent,
	saveSkillPendingIntent,
	touchUserSecret,
	type UserSecretRow,
} from "@workspace/db";
import { itemAad, openItem, unwrapDataKey } from "@workspace/db/vault-crypto";
import { VAULT_ENVIRONMENT_ID, type ComputerUseEvent } from "@workspace/shared";

/** Conteúdo selado de um item (mesmo formato do `VaultService` legado: os dois leem as mesmas linhas). */
type SealedPayload = { value?: string; password?: string; totp?: string };

export type V4VaultDeps = {
	listMeta: typeof listUserSecrets;
	getByName: typeof getUserSecretByName;
	getKey: typeof getUserVaultKey;
	touch: typeof touchUserSecret;
	audit: typeof appendUserSecretAudit;
	unwrap(wrapped: string): Buffer;
	open(key: Buffer, userId: string, row: Pick<UserSecretRow, "id" | "valueEnc">): SealedPayload;
	saveIntent: typeof saveSkillPendingIntent;
	persistCard: (conversationId: string, event: ComputerUseEvent) => Promise<void>;
};

export const realV4VaultDeps: V4VaultDeps = {
	listMeta: listUserSecrets,
	getByName: getUserSecretByName,
	getKey: getUserVaultKey,
	touch: touchUserSecret,
	audit: appendUserSecretAudit,
	unwrap: (wrapped) => unwrapDataKey(wrapped),
	open: (key, userId, row) => openItem<SealedPayload>(key, itemAad(userId, row.id), row.valueEnc),
	saveIntent: saveSkillPendingIntent,
	persistCard: (conversationId, event) => persistConversationCardFromEvent(conversationId, event),
};

/** Falha fixa e sem dado: o cofre existe mas não abre (chave do servidor ausente/trocada, item corrompido). */
export class VaultUnavailableError extends Error {
	constructor() {
		super("The vault could not be opened right now (server key missing or changed). Tell the owner plainly; do not retry.");
		this.name = "VaultUnavailableError";
	}
}

async function openRow(deps: V4VaultDeps, userId: string, row: UserSecretRow): Promise<SealedPayload> {
	try {
		const wrapped = await deps.getKey(userId);
		if (!wrapped) throw new Error("no key");
		return deps.open(deps.unwrap(wrapped), userId, row);
	} catch {
		throw new VaultUnavailableError();
	}
}

/** Backend da porta `Vault` do motor: `listHandles` (metadados) e `resolveSecret` (só segredo simples). */
export function createV4VaultBackend(deps: V4VaultDeps = realV4VaultDeps): VaultBackend {
	return {
		async listHandles(userId) {
			const metas = await deps.listMeta(userId);
			return metas.map(
				(meta): SecretHandle => ({
					id: meta.name,
					label: meta.label || meta.name,
					kind: meta.kind,
					...(meta.description && { description: meta.description }),
					...(meta.kind === "login" && meta.domain && { site: meta.domain }),
					...(meta.kind === "login" && meta.username && { username: meta.username }),
				}),
			);
		},
		async resolveSecret(userId, handleId) {
			const row = await deps.getByName(userId, handleId);
			// Login não é "segredo simples": a senha só vai à VM por `login_fill`.
			if (!row || row.kind !== "secret") return null;
			const value = (await openRow(deps, userId, row)).value;
			if (!value) return null;
			await deps.touch(userId, row.id).catch(() => undefined);
			await deps.audit(userId, row.id, { action: "used", actor: "bot", detail: "agent_v4" }).catch(() => undefined);
			return value;
		},
	};
}

export type LoginFields = { username?: string; password?: string };
export type LoginRecord = { id: string; name: string; siteUrl: string | null; domain: string | null };

/** O que o tratador `vault.login_fill` precisa do cofre. Os valores só existem aqui dentro, no worker. */
export type LoginSource = {
	getLogin(userId: string, name: string): Promise<LoginRecord | null>;
	/** Lê usuário e/ou senha do login do dono e audita "usado". */
	useLogin(userId: string, login: LoginRecord, fields: ReadonlyArray<"username" | "password">): Promise<LoginFields>;
};

export function createV4LoginSource(deps: V4VaultDeps = realV4VaultDeps): LoginSource {
	return {
		async getLogin(userId, name) {
			const row = await deps.getByName(userId, name);
			return row && row.kind === "login" ? { id: row.id, name: row.name, siteUrl: row.siteUrl, domain: row.domain } : null;
		},
		async useLogin(userId, login, fields) {
			// Reconfere o dono e o tipo na leitura (o `LoginRecord` veio de `getLogin`, mas o valor nunca sai sem este filtro).
			const row = await deps.getByName(userId, login.name);
			if (!row || row.kind !== "login" || row.id !== login.id) throw new Error("That login is not in this owner's vault.");
			const payload = await openRow(deps, userId, row);
			await deps.touch(userId, row.id).catch(() => undefined);
			await deps.audit(userId, row.id, { action: "used", actor: "bot", detail: `login_fill: ${fields.join(", ")}` }).catch(() => undefined);
			return {
				...(fields.includes("username") && row.username ? { username: row.username } : {}),
				...(fields.includes("password") && payload.password ? { password: payload.password } : {}),
			};
		},
	};
}

export const realV4LoginSource: LoginSource = createV4LoginSource();

export type V4VaultScope = {
	conversationId?: string | null;
	botId?: string | null;
	emit: (event: ComputerUseEvent) => void | Promise<void>;
	log?: (message: string) => void;
};

/** Validade do pedido: o dono pode voltar horas depois (mesma janela do legado). */
const REQUEST_TTL_MS = 60 * 60_000;

/**
 * Cartão "cadastre este segredo": o mesmo `confirm` com `secretsRequest` do legado (o card da web e do celular e a rota da API
 * que guarda o valor direto no cofre já existem). Só nomes e o motivo viajam aqui; o valor o dono digita no campo do cartão.
 */
export function createV4SecretRequests(input: { scope: V4VaultScope; deps?: V4VaultDeps }): SecretRequests {
	const deps = input.deps ?? realV4VaultDeps;
	const { scope } = input;
	const shown = new Set<string>();
	return {
		async ask(userId, runId, request) {
			const conversationId = scope.conversationId;
			if (!conversationId) throw new Error("There is no conversation to show the card in, so the owner cannot be asked here.");
			const confirmId = `confirm-${runId}`;
			const names = [...request.names];
			if (shown.has(confirmId)) throw new Error("A card asking for secrets was already shown in this run; wait for the owner's answer.");
			shown.add(confirmId);
			await deps.saveIntent({
				userId,
				conversationId,
				payload: { kind: "confirm", action: "request-secrets", confirmId, ...(scope.botId && { botId: scope.botId }), secretsRequest: { environmentId: VAULT_ENVIRONMENT_ID, repo: "", names } },
				ttlMs: REQUEST_TTL_MS,
			});
			const card: ComputerUseEvent = {
				type: "confirm",
				confirmId,
				title: names.length === 1 ? `O bot precisa da chave ${names[0]}` : `O bot precisa de: ${names.join(", ")}`,
				description: request.reason,
				confirmLabel: "Salvar no cofre",
				cancelLabel: "Agora não",
				secretsRequest: { environmentId: VAULT_ENVIRONMENT_ID, repo: "", names, reason: request.reason },
			};
			await deps.persistCard(conversationId, card).catch((error: unknown) => {
				scope.log?.(`[engine-v4] run=${runId} não consegui gravar o cartão do cofre: ${error instanceof Error ? error.name : "erro"}`);
			});
			await scope.emit(card);
		},
	};
}

/** Portas do cofre de um run para a capacidade `vault` (a porta `Vault` do kernel é montada pelo motor com o mesmo backend). */
export function createV4Vault(input: { scope: V4VaultScope; deps?: V4VaultDeps }): { backend: VaultBackend; requests?: SecretRequests } {
	return {
		backend: createV4VaultBackend(input.deps),
		// Sem conversa (rotina sem chat) não há onde mostrar o cartão: a tool nem é oferecida.
		...(input.scope.conversationId && { requests: createV4SecretRequests(input) }),
	};
}
