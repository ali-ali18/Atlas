import { createDevEnvironment, getDevEnvironmentByRepo, updateDevEnvironment, type DevEnvironmentRecord } from "@workspace/db";
import { DEFAULT_COMMAND_ALLOWLIST, type DevEnvTier } from "@workspace/shared";
import { isSecretBoxConfigured, openSecrets } from "../secrets/secret-box.js";
import type { DevEnvironmentRuntime } from "./dev-environment.js";

/** Abre os segredos selados de um ambiente (vazio se a chave não estiver configurada ou não abrir). */
export function openEnvironmentSecrets(sealed: string | null): Record<string, string> {
	if (!sealed || !isSecretBoxConfigured()) return {};
	try {
		const parsed = openSecrets<Record<string, unknown>>(sealed);
		return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
	} catch {
		return {};
	}
}

/** Ambiente salvo do repositório com os segredos abertos, só para uso no servidor (nunca devolver ao cliente). */
export async function loadDevEnvironmentRuntime(userId: string, repo: string): Promise<DevEnvironmentRuntime | null> {
	const record = await getDevEnvironmentByRepo(userId, repo);
	return record ? toRuntime(record) : null;
}

function toRuntime(record: DevEnvironmentRecord): DevEnvironmentRuntime {
	return {
		id: record.id,
		repo: record.repo,
		installCommand: record.installCommand,
		startCommand: record.startCommand,
		testCommand: record.testCommand,
		tier: record.tier,
		network: record.network,
		allowlist: record.allowlist,
		approvalMode: record.approvalMode,
		commandAllowlist: record.commandAllowlist,
		secrets: openEnvironmentSecrets(record.sealedSecrets),
		source: record.source,
		userEditedFields: record.userEditedFields,
	};
}

/** Cria o ambiente automático do repositório (ou devolve o que já existe: nunca sobrescreve). */
export async function createAutoDevEnvironment(
	userId: string,
	repo: string,
	fields: { installCommand: string | null; startCommand: string | null; testCommand?: string | null; tier: DevEnvTier; commandAllowlist: string[] },
): Promise<DevEnvironmentRuntime | null> {
	const existing = await getDevEnvironmentByRepo(userId, repo);
	if (existing) return toRuntime(existing);
	try {
		const created = await createDevEnvironment(userId, {
			repo: repo.toLowerCase(),
			installCommand: fields.installCommand,
			startCommand: fields.startCommand,
			testCommand: fields.testCommand ?? null,
			tier: fields.tier,
			network: "allowlist",
			allowlist: [],
			approvalMode: null,
			commandAllowlist: fields.commandAllowlist.length ? fields.commandAllowlist : [...DEFAULT_COMMAND_ALLOWLIST],
			source: "auto",
			userEditedFields: [],
		});
		return toRuntime(created);
	} catch {
		// corrida com outra criação: lê o que ficou
		const again = await getDevEnvironmentByRepo(userId, repo);
		return again ? toRuntime(again) : null;
	}
}

/** Grava o que o agente aprendeu (rede e segredos nunca passam por aqui). */
export async function patchAutoDevEnvironment(
	userId: string,
	repo: string,
	patch: { installCommand?: string; startCommand?: string; testCommand?: string; commandAllowlist?: string[]; tier?: DevEnvTier },
): Promise<DevEnvironmentRuntime | null> {
	const existing = await getDevEnvironmentByRepo(userId, repo);
	if (!existing) return null;
	const updated = await updateDevEnvironment(existing.id, userId, patch);
	return updated ? toRuntime(updated) : null;
}
