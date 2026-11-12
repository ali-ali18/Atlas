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
	listUserSecretRows,
	listUserSecrets,
	persistConversationCardFromEvent,
	saveSkillPendingIntent,
	touchUserSecret,
	type UserSecretRow,
} from "@workspace/db";
import { itemAad, openItem, unwrapDataKey } from "@workspace/db/vault-crypto";
import { loginFieldDecls, loginFieldsView, readStoredLoginFields, VAULT_ENVIRONMENT_ID, type ComputerUseEvent, type LoginFieldValue } from "@workspace/shared";

/** Conteúdo selado de um item (mesmo formato do `VaultService` legado: os dois leem as mesmas linhas). */
type SealedPayload = { value?: string; password?: string; totp?: string; /** Login com campos declarados pela IA (F9); login antigo não tem. */ fields?: unknown };

export type V4VaultDeps = {
	listMeta: typeof listUserSecrets;
	/** Linhas com o valor selado: só para ler a DECLARAÇÃO dos campos de login (chave, rótulo, secreto), nunca o valor. */
	listRows: typeof listUserSecretRows;
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
	listRows: listUserSecretRows,
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

/** Campos (com valor, só dentro do worker) de cada login do dono, por id de item. Cofre que não abre: sem o mapa (a lista cai no usuário). */
async function loginFieldsByItem(deps: V4VaultDeps, userId: string): Promise<Map<string, LoginFieldValue[]>> {
	const out = new Map<string, LoginFieldValue[]>();
	try {
		const wrapped = await deps.getKey(userId);
		if (!wrapped) return out;
		const key = deps.unwrap(wrapped);
		for (const row of await deps.listRows(userId)) {
			if (row.kind !== "login") continue;
			try {
				const payload = deps.open(key, userId, row);
				out.set(row.id, loginFieldsView({ username: row.username, password: payload.password, fields: readStoredLoginFields(payload.fields) }));
			} catch {
				// item que não abre: cai no que está em claro
			}
		}
	} catch {
		// sem chave do servidor: a lista mostra só o que está em claro
	}
	return out;
}

/** Backend da porta `Vault` do motor: `listHandles` (metadados) e `resolveSecret` (só segredo simples). */
export function createV4VaultBackend(deps: V4VaultDeps = realV4VaultDeps, scope?: Pick<V4VaultScope, "botId" | "botName" | "conversationId">): VaultBackend {
	return {
		async listHandles(userId) {
			const metas = await deps.listMeta(userId);
			// Campos de login: a declaração (chave, rótulo, secreto) vem do selado; o valor nunca sai daqui.
			const fields = metas.some((meta) => meta.kind === "login") ? await loginFieldsByItem(deps, userId) : new Map<string, LoginFieldValue[]>();
			return metas.map(
				(meta): SecretHandle => ({
					id: meta.name,
					label: meta.label || meta.name,
					kind: meta.kind,
					...(meta.description && { description: meta.description }),
					...(meta.kind === "login" && meta.domain && { site: meta.domain }),
					...(meta.kind === "login" && meta.username && { username: meta.username }),
					...(meta.kind === "login" && { fields: loginFieldDecls(fields.get(meta.id) ?? loginFieldsView({ username: meta.username })) }),
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
			await deps.audit(userId, row.id, {
				action: "used",
				actor: "bot",
				detail: "agent_v4",
				// Quem usou: o histórico do segredo mostra qual bot, em qual conversa (só ids e o nome do bot; nunca o valor).
				...(scope?.botId && { botId: scope.botId }),
				...(scope?.botName && { botName: scope.botName }),
				...(scope?.conversationId && { conversationId: scope.conversationId }),
			}).catch(() => undefined);
			return value;
		},
	};
}

export type LoginRecord = { id: string; name: string; siteUrl: string | null; domain: string | null };

/** Campos do login que o modelo pediu (valores só aqui, no worker) e as chaves que o login tem (só nomes, para o erro). */
export type LoginUse = { saved: string[]; fields: Array<{ key: string; secret: boolean; value: string }> };

/** O que o tratador `vault.login_fill` precisa do cofre. Os valores só existem aqui dentro, no worker. */
export type LoginSource = {
	getLogin(userId: string, name: string): Promise<LoginRecord | null>;
	/** Todos os logins do dono (só nome e site, nunca valor): o `login_fill` sem nome acha o do site da página atual. */
	listLogins(userId: string): Promise<LoginRecord[]>;
	/** Lê os campos pedidos (por chave) do login do dono e audita "usado". Chave que o login não tem não vem em `fields`. */
	useLogin(userId: string, login: LoginRecord, keys: readonly string[]): Promise<LoginUse>;
};

export function createV4LoginSource(deps: V4VaultDeps = realV4VaultDeps): LoginSource {
	/** Reconfere o dono e o tipo na leitura (o `LoginRecord` veio de `getLogin`, mas o valor nunca sai sem este filtro). */
	async function openLogin(userId: string, login: LoginRecord) {
		const row = await deps.getByName(userId, login.name);
		if (!row || row.kind !== "login" || row.id !== login.id) throw new Error("That login is not in this owner's vault.");
		const payload = await openRow(deps, userId, row);
		return { row, fields: loginFieldsView({ username: row.username, password: payload.password, fields: readStoredLoginFields(payload.fields) }) };
	}
	return {
		async getLogin(userId, name) {
			const row = await deps.getByName(userId, name);
			return row && row.kind === "login" ? { id: row.id, name: row.name, siteUrl: row.siteUrl, domain: row.domain } : null;
		},
		async listLogins(userId) {
			const metas = await deps.listMeta(userId);
			return metas.filter((meta) => meta.kind === "login").map((meta) => ({ id: meta.id, name: meta.name, siteUrl: meta.siteUrl, domain: meta.domain }));
		},
		async useLogin(userId, login, keys) {
			const { row, fields } = await openLogin(userId, login);
			const picked = keys.flatMap((key) => {
				const found = fields.find((f) => f.key === key);
				return found ? [{ key: found.key, secret: found.secret, value: found.value }] : [];
			});
			// Só audita quando há o que digitar (chave inexistente não usa o login).
			if (picked.length > 0) {
				await deps.touch(userId, row.id).catch(() => undefined);
				await deps.audit(userId, row.id, { action: "used", actor: "bot", detail: `login_fill: ${picked.map((f) => f.key).join(", ")}` }).catch(() => undefined);
			}
			return { saved: fields.map((f) => f.key), fields: picked };
		},
	};
}

export const realV4LoginSource: LoginSource = createV4LoginSource();

export type V4VaultScope = {
	conversationId?: string | null;
	botId?: string | null;
	botName?: string | null;
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
			// Login: um campo de digitar por item declarado (chave, rótulo, secreto); o valor nunca entra no cartão.
			const login = request.login ? { site: request.login.site, ...(request.login.name && { name: request.login.name }), fields: request.login.fields.map(({ key, label, secret }) => ({ key, label, secret })) } : undefined;
			if (shown.has(confirmId)) throw new Error("A card asking for secrets was already shown in this run; wait for the owner's answer.");
			shown.add(confirmId);
			await deps.saveIntent({
				userId,
				conversationId,
				payload: { kind: "confirm", action: "request-secrets", confirmId, ...(scope.botId && { botId: scope.botId }), secretsRequest: { environmentId: VAULT_ENVIRONMENT_ID, repo: "", names, ...(login && { login }) } },
				ttlMs: REQUEST_TTL_MS,
			});
			const card: ComputerUseEvent = {
				type: "confirm",
				confirmId,
				title: login ? `O bot precisa do seu login de ${login.site}` : names.length === 1 ? `O bot precisa da chave ${names[0]}` : `O bot precisa de: ${names.join(", ")}`,
				description: request.reason,
				confirmLabel: "Salvar no cofre",
				cancelLabel: "Agora não",
				secretsRequest: { environmentId: VAULT_ENVIRONMENT_ID, repo: "", names, reason: request.reason, ...(login && { login }) },
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
		backend: createV4VaultBackend(input.deps, input.scope),
		// Sem conversa (rotina sem chat) não há onde mostrar o cartão: a tool nem é oferecida.
		...(input.scope.conversationId && { requests: createV4SecretRequests(input) }),
	};
}
