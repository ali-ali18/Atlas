import { randomBytes } from "node:crypto";
import {
	appendUserSecretAudit,
	createUserSecretRow,
	createUserVaultKey,
	deleteUserSecretRow,
	getUserSecretById,
	getUserSecretByName,
	getUserVaultKey,
	listUserRoutineWebhooks,
	listUserSecretAudit,
	listUserSecretRows,
	setHookSecretSealer,
	touchUserSecret,
	updateUserSecretRow,
	type UserRoutineWebhook,
	type UserSecretAuditAction,
	type UserSecretAuditRow,
	type UserSecretRow,
} from "@workspace/db";
import { hostOf, isValidSecretName, loginMarker, routineSecretMarker, secretMarker, suggestSecretName, type SecretRef } from "@workspace/shared";
import { readConnectorKey } from "./secret-box.js";
import { itemAad, newDataKey, openItem, sealItem, unwrapDataKey, wrapDataKey } from "./envelope.js";
import type { SecretEntry } from "./redact.js";
import { parseTotpInput, totpAt } from "./totp.js";

export class VaultError extends Error {
	constructor(
		message: string,
		readonly code: "not_found" | "invalid" | "conflict" | "unavailable" = "invalid",
	) {
		super(message);
		this.name = "VaultError";
	}
}

export type VaultExtraField = { name: string; value: string; secret: boolean };
/** Conteúdo sensível (selado). */
export type VaultPayload = {
	/** kind=secret */
	value?: string;
	/** kind=login */
	password?: string;
	/** Chave base32 ou otpauth://. */
	totp?: string;
	notes?: string;
	extras?: VaultExtraField[];
};

export type VaultMeta = {
	id: string;
	kind: "secret" | "login";
	name: string;
	label: string;
	description: string;
	siteUrl: string | null;
	domain: string | null;
	username: string | null;
	createdAt: string;
	updatedAt: string;
	lastUsedAt: string | null;
	alwaysBots: string[];
};

export type VaultActor = { actor?: "user" | "bot"; botId?: string; botName?: string; conversationId?: string; detail?: string };

/** Porta de persistência (default = Prisma; testes usam memória). */
export type VaultStore = {
	getKey: (userId: string) => Promise<string | null>;
	createKey: (userId: string, wrapped: string) => Promise<string>;
	listRows: (userId: string) => Promise<UserSecretRow[]>;
	getById: (userId: string, id: string) => Promise<UserSecretRow | null>;
	getByName: (userId: string, name: string) => Promise<UserSecretRow | null>;
	create: typeof createUserSecretRow;
	update: typeof updateUserSecretRow;
	remove: (userId: string, id: string) => Promise<boolean>;
	touch: (userId: string, id: string) => Promise<void>;
	audit: (userId: string, secretId: string, entry: { action: UserSecretAuditAction } & VaultActor) => Promise<void>;
	listAudit: (userId: string, secretId: string, take?: number) => Promise<UserSecretAuditRow[]>;
	routineWebhooks: (userId: string) => Promise<UserRoutineWebhook[]>;
};

// Wrappers preguiçosos: o módulo carrega mesmo onde o db é simulado (testes) e só falha se for usado.
export const dbVaultStore: VaultStore = {
	getKey: (...a) => getUserVaultKey(...a),
	createKey: (...a) => createUserVaultKey(...a),
	listRows: (...a) => listUserSecretRows(...a),
	getById: (...a) => getUserSecretById(...a),
	getByName: (...a) => getUserSecretByName(...a),
	create: (...a) => createUserSecretRow(...a),
	update: (...a) => updateUserSecretRow(...a),
	remove: (...a) => deleteUserSecretRow(...a),
	touch: (...a) => touchUserSecret(...a),
	audit: (...a) => appendUserSecretAudit(...a),
	listAudit: (...a) => listUserSecretAudit(...a),
	routineWebhooks: (...a) => listUserRoutineWebhooks(...a),
};

function toMeta(row: UserSecretRow): VaultMeta {
	return {
		id: row.id,
		kind: row.kind,
		name: row.name,
		label: row.label,
		description: row.description,
		siteUrl: row.siteUrl,
		domain: row.domain,
		username: row.username,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
		alwaysBots: row.alwaysBots ?? [],
	};
}

export type CreateVaultItemInput = {
	kind: "secret" | "login";
	name: string;
	label?: string;
	description?: string;
	siteUrl?: string;
	username?: string;
	payload: VaultPayload;
};

export type ResolvedSecret = { value: string; marker: string; secretId?: string; label: string; routine?: boolean };

export function routineSlug(routine: { name: string; routineId: string }): string {
	return suggestSecretName(routine.name, routine.routineId);
}

export class VaultService {
	constructor(private readonly store: VaultStore = dbVaultStore) {}

	private async dataKey(userId: string, create: boolean): Promise<Buffer | null> {
		if (!userId?.trim()) throw new VaultError("usuário inválido", "invalid");
		let wrapped = await this.store.getKey(userId);
		if (!wrapped) {
			if (!create) return null;
			try {
				wrapped = await this.store.createKey(userId, wrapDataKey(newDataKey()));
			} catch (error) {
				throw new VaultError(error instanceof Error ? error.message : "cofre indisponível (chave do servidor ausente)", "unavailable");
			}
		}
		try {
			return unwrapDataKey(wrapped);
		} catch {
			throw new VaultError("cofre indisponível (chave do servidor ausente ou trocada)", "unavailable");
		}
	}

	private open(key: Buffer, row: UserSecretRow): VaultPayload {
		try {
			return openItem<VaultPayload>(key, itemAad(row.userId, row.id), row.valueEnc);
		} catch {
			throw new VaultError("não foi possível abrir este item", "unavailable");
		}
	}

	async listMeta(userId: string): Promise<VaultMeta[]> {
		return (await this.store.listRows(userId)).map(toMeta);
	}

	async getMeta(userId: string, id: string): Promise<VaultMeta> {
		const row = await this.store.getById(userId, id);
		if (!row) throw new VaultError("não encontrado", "not_found");
		return toMeta(row);
	}

	async create(userId: string, input: CreateVaultItemInput, by: VaultActor = {}): Promise<VaultMeta> {
		const name = input.name.trim();
		if (!isValidSecretName(name)) throw new VaultError("Nome inválido: use letras, números, - e _ (até 64).", "invalid");
		if (await this.store.getByName(userId, name)) throw new VaultError(`Já existe um item chamado "${name}".`, "conflict");
		this.validatePayload(input.kind, input.payload);
		const key = (await this.dataKey(userId, true))!;
		const id = `vs_${randomBytes(12).toString("base64url")}`;
		const siteUrl = input.siteUrl?.trim() || undefined;
		const row = await this.store.create(userId, {
			id,
			kind: input.kind,
			name,
			label: (input.label ?? "").trim().slice(0, 120),
			description: (input.description ?? "").trim().slice(0, 300),
			siteUrl: siteUrl ?? null,
			domain: siteUrl ? hostOf(siteUrl) : null,
			username: input.username?.trim() || null,
			valueEnc: sealItem(key, itemAad(userId, id), input.payload),
		});
		await this.store.audit(userId, id, { action: "created", actor: by.actor ?? "user", ...by }).catch(() => undefined);
		return toMeta(row);
	}

	private validatePayload(kind: "secret" | "login", payload: VaultPayload) {
		if (kind === "secret" && !payload.value) throw new VaultError("Informe o valor do segredo.", "invalid");
		if (kind === "login" && !payload.password) throw new VaultError("Informe a senha.", "invalid");
		if (payload.totp?.trim() && !parseTotpInput(payload.totp)) throw new VaultError("Chave 2FA inválida (cole a chave base32 ou o link otpauth://).", "invalid");
	}

	/** Cria ou troca o valor de um segredo simples pelo nome (cartão `secret_request` e composer). */
	async upsertSecret(userId: string, name: string, value: string, description = "", by: VaultActor = {}): Promise<VaultMeta> {
		const existing = await this.store.getByName(userId, name);
		if (!existing) return this.create(userId, { kind: "secret", name, description, payload: { value } }, by);
		if (existing.kind !== "secret") throw new VaultError(`"${name}" é um login; escolha outro nome.`, "conflict");
		return this.update(userId, existing.id, { payload: { value }, ...(description ? { description } : {}) }, by);
	}

	async update(
		userId: string,
		id: string,
		patch: { name?: string; label?: string; description?: string; siteUrl?: string; username?: string; payload?: Partial<VaultPayload> },
		by: VaultActor = {},
	): Promise<VaultMeta> {
		const row = await this.store.getById(userId, id);
		if (!row) throw new VaultError("não encontrado", "not_found");
		const write: Parameters<VaultStore["update"]>[2] = {};
		if (patch.name !== undefined) {
			const name = patch.name.trim();
			if (!isValidSecretName(name)) throw new VaultError("Nome inválido: use letras, números, - e _ (até 64).", "invalid");
			if (name !== row.name && (await this.store.getByName(userId, name))) throw new VaultError(`Já existe um item chamado "${name}".`, "conflict");
			write.name = name;
		}
		if (patch.label !== undefined) write.label = patch.label.trim().slice(0, 120);
		if (patch.description !== undefined) write.description = patch.description.trim().slice(0, 300);
		if (patch.siteUrl !== undefined) {
			const siteUrl = patch.siteUrl.trim();
			write.siteUrl = siteUrl || null;
			write.domain = siteUrl ? hostOf(siteUrl) : null;
		}
		if (patch.username !== undefined) write.username = patch.username.trim() || null;
		if (patch.payload) {
			const key = (await this.dataKey(userId, true))!;
			const merged: VaultPayload = { ...this.open(key, row), ...patch.payload };
			if (merged.totp !== undefined && !merged.totp.trim()) delete merged.totp;
			this.validatePayload(row.kind, merged);
			write.valueEnc = sealItem(key, itemAad(userId, id), merged);
		}
		const updated = await this.store.update(userId, id, write);
		if (!updated) throw new VaultError("não encontrado", "not_found");
		await this.store.audit(userId, id, { action: "updated", actor: by.actor ?? "user", ...by, detail: by.detail ?? Object.keys(patch).join(",") }).catch(() => undefined);
		return toMeta(updated);
	}

	async remove(userId: string, id: string): Promise<void> {
		if (!(await this.store.remove(userId, id))) throw new VaultError("não encontrado", "not_found");
	}

	async reveal(userId: string, id: string, by: VaultActor = {}, action: "revealed" | "copied" = "revealed"): Promise<{ meta: VaultMeta; payload: VaultPayload }> {
		const row = await this.store.getById(userId, id);
		if (!row) throw new VaultError("não encontrado", "not_found");
		const key = await this.dataKey(userId, false);
		if (!key) throw new VaultError("cofre sem chave", "unavailable");
		const payload = this.open(key, row);
		await this.store.audit(userId, id, { action, actor: by.actor ?? "user", ...by }).catch(() => undefined);
		return { meta: toMeta(row), payload };
	}

	async recordCopy(userId: string, id: string, what: string): Promise<void> {
		if (!(await this.store.getById(userId, id))) throw new VaultError("não encontrado", "not_found");
		await this.store.audit(userId, id, { action: "copied", actor: "user", detail: what });
	}

	async auditLog(userId: string, id: string): Promise<UserSecretAuditRow[]> {
		if (!(await this.store.getById(userId, id))) throw new VaultError("não encontrado", "not_found");
		return this.store.listAudit(userId, id);
	}

	/** Código 2FA do momento (nunca guarda o código). */
	async totpCode(userId: string, id: string, by: VaultActor = {}): Promise<{ code: string; expiresInSec: number }> {
		const row = await this.store.getById(userId, id);
		if (!row) throw new VaultError("não encontrado", "not_found");
		const key = await this.dataKey(userId, false);
		if (!key) throw new VaultError("cofre sem chave", "unavailable");
		const payload = this.open(key, row);
		if (!payload.totp) throw new VaultError("Este login não tem código 2FA.", "invalid");
		const result = totpAt(payload.totp);
		await this.store.audit(userId, id, { action: by.actor === "bot" ? "used" : "copied", actor: by.actor ?? "user", ...by, detail: by.detail ?? "código 2FA" }).catch(() => undefined);
		return result;
	}

	// ----- uso pelo runtime -----

	private async findRoutine(userId: string, slugOrId: string): Promise<UserRoutineWebhook | undefined> {
		const hooks = await this.store.routineWebhooks(userId);
		const wanted = slugOrId.toLowerCase();
		return hooks.find((hook) => routineSlug(hook).toLowerCase() === wanted || hook.routineId === slugOrId || hook.hookKey === slugOrId);
	}

	async routineSecret(userId: string, hook: UserRoutineWebhook): Promise<string | undefined> {
		if (!hook.secretEnc) return undefined;
		const key = await this.dataKey(userId, false);
		if (!key) return undefined;
		try {
			return openItem<{ s?: string }>(key, itemAad(userId, `hook:${hook.hookKey}`), hook.secretEnc).s;
		} catch {
			return undefined;
		}
	}

	/** Valor real de uma referência (null = não existe / sem valor). Só do dono. */
	async resolveRef(userId: string, ref: SecretRef, by: VaultActor = {}): Promise<ResolvedSecret | null> {
		if (ref.kind === "routine") {
			const hook = await this.findRoutine(userId, ref.slug);
			if (!hook) return null;
			const value = await this.routineSecret(userId, hook);
			return value ? { value, marker: routineSecretMarker(routineSlug(hook)), label: `rotina "${hook.name}"`, routine: true } : null;
		}
		const row = await this.store.getByName(userId, ref.name);
		if (!row) return null;
		const key = await this.dataKey(userId, false);
		if (!key) return null;
		const payload = this.open(key, row);
		let value: string | undefined;
		if (ref.kind === "secret") {
			if (row.kind !== "secret") return null;
			value = payload.value;
		} else {
			if (row.kind !== "login") return null;
			if (ref.field === "username") value = row.username ?? undefined;
			else if (ref.field === "password") value = payload.password;
			else value = payload.totp ? totpAt(payload.totp).code : undefined;
		}
		if (!value) return null;
		await this.store.touch(userId, row.id).catch(() => undefined);
		await this.store.audit(userId, row.id, { action: "used", actor: by.actor ?? "bot", ...by, detail: by.detail ?? (ref.kind === "login" ? ref.field : undefined) }).catch(() => undefined);
		return { value, marker: ref.kind === "login" ? loginMarker(ref.name, ref.field) : secretMarker(ref.name), secretId: row.id, label: `"${row.label || row.name}"` };
	}

	/** Frase para o cartão de aprovação ("o segredo da rotina X será gravado em N"). */
	async describeRef(userId: string, ref: SecretRef, destination: string): Promise<string> {
		if (ref.kind === "routine") {
			const hook = await this.findRoutine(userId, ref.slug);
			return `O segredo da rotina "${hook?.name ?? ref.slug}" será gravado em ${destination}.`;
		}
		const row = await this.store.getByName(userId, ref.name);
		const label = row?.label || ref.name;
		if (ref.kind === "login") {
			const what = ref.field === "username" ? "O usuário" : ref.field === "totp" ? "O código 2FA" : "A senha";
			return `${what} do login "${label}" será enviado para ${destination}.`;
		}
		return `O segredo "${label}" será enviado para ${destination}.`;
	}

	/** Todos os valores secretos do usuário (para redação), com o marcador de cada um. */
	async redactionEntries(userId: string): Promise<SecretEntry[]> {
		const out: SecretEntry[] = [];
		if (!readConnectorKey()) return out; // sem chave mestra não há cofre
		const rows = await this.store.listRows(userId);
		const key = rows.length > 0 || (await this.store.routineWebhooks(userId)).length > 0 ? await this.dataKey(userId, false).catch(() => null) : null;
		if (!key) return out;
		for (const row of rows) {
			let payload: VaultPayload;
			try {
				payload = this.open(key, row);
			} catch {
				continue;
			}
			if (row.kind === "secret") {
				if (payload.value) out.push({ value: payload.value, marker: secretMarker(row.name) });
			} else {
				if (payload.password) out.push({ value: payload.password, marker: loginMarker(row.name, "password") });
				if (payload.totp) {
					const config = parseTotpInput(payload.totp);
					if (config) out.push({ value: config.secret, marker: loginMarker(row.name, "totp") });
				}
				for (const extra of payload.extras ?? []) if (extra.secret && extra.value) out.push({ value: extra.value, marker: `{{secret:${row.name}}}` });
			}
		}
		for (const hook of await this.store.routineWebhooks(userId)) {
			const value = await this.routineSecret(userId, hook);
			if (value) out.push({ value, marker: routineSecretMarker(routineSlug(hook)) });
		}
		return out;
	}

	// ----- aprovação de uso de login por conversa -----

	async isLoginApproved(userId: string, meta: Pick<VaultMeta, "id" | "alwaysBots">, botId: string | undefined, conversationId: string | undefined): Promise<boolean> {
		if (botId && meta.alwaysBots.includes(botId)) return true;
		if (!conversationId) return false;
		const log = await this.store.listAudit(userId, meta.id, 200);
		return log.some((entry) => entry.action === "approved" && entry.conversationId === conversationId);
	}

	async approveLogin(userId: string, id: string, input: { botId?: string; conversationId?: string; always?: boolean }): Promise<void> {
		const row = await this.store.getById(userId, id);
		if (!row) throw new VaultError("não encontrado", "not_found");
		if (input.always && input.botId && !(row.alwaysBots ?? []).includes(input.botId)) {
			await this.store.update(userId, id, { alwaysBots: [...(row.alwaysBots ?? []), input.botId] });
		}
		await this.store.audit(userId, id, {
			action: "approved" as UserSecretAuditAction,
			actor: "user",
			botId: input.botId,
			conversationId: input.conversationId,
			detail: input.always ? "sempre para este bot" : "nesta conversa",
		});
	}

	/** Valores de um login para o runtime digitar na página (nunca vão ao modelo). Audita "usado". */
	async useLogin(userId: string, id: string, fields: Array<"username" | "password" | "totp">, by: VaultActor = {}): Promise<{ username?: string; password?: string; totp?: string }> {
		const row = await this.store.getById(userId, id);
		if (!row || row.kind !== "login") throw new VaultError("não encontrado", "not_found");
		const key = await this.dataKey(userId, false);
		if (!key) throw new VaultError("cofre sem chave", "unavailable");
		const payload = this.open(key, row);
		await this.store.touch(userId, id).catch(() => undefined);
		await this.store.audit(userId, id, { action: "used", actor: by.actor ?? "bot", ...by, detail: `login_fill: ${fields.join(", ")}` }).catch(() => undefined);
		return {
			...(fields.includes("username") && row.username ? { username: row.username } : {}),
			...(fields.includes("password") && payload.password ? { password: payload.password } : {}),
			...(fields.includes("totp") && payload.totp ? { totp: totpAt(payload.totp).code } : {}),
		};
	}

	/** Grava a cópia recuperável do secret do webhook (envelope do dono). */
	async sealHookSecret(userId: string, hookKey: string, secret: string): Promise<string> {
		const key = (await this.dataKey(userId, true))!;
		return sealItem(key, itemAad(userId, `hook:${hookKey}`), { s: secret });
	}
}

let shared: VaultService | null = null;
/** Só testes: troca o serviço compartilhado (store em memória). */
export function setVaultServiceForTests(service: VaultService | null): void {
	shared = service;
}
export function getVaultService(): VaultService {
	if (!shared) shared = new VaultService();
	return shared;
}

/** Liga o db (criação/rotação de webhook) ao cofre. Idempotente. */
export function registerHookSecretSealer(service: VaultService = getVaultService()): void {
	try {
		setHookSecretSealer((userId, hookKey, secret) => service.sealHookSecret(userId, hookKey, secret));
	} catch {
		// db simulado em teste: sem registro.
	}
}

// Quem importa o runtime (API/worker) passa a guardar a cópia recuperável do secret de webhook.
registerHookSecretSealer();
