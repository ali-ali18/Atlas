"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
	clearDevEnvironmentCache,
	createDevEnvironment,
	deleteDevEnvironment,
	deleteDevEnvironmentSecret,
	listDevEnvironments,
	setDevApprovalDefault,
	setDevVerifier,
	setDevEnvironmentSecrets,
	updateDevEnvironment,
	type DevEnvironmentView,
} from "@/lib/atlas-api";
import { normalizeEnvRepo, parseEnvPaste, type DevApprovalMode } from "@workspace/shared";
import { envErrorMessage, inputFromForm, type DevEnvForm } from "@/components/settings/dev-environments-state";
import { activeT } from "@/lib/i18n/active";

export type SaveEnvironmentResult = { ok: true; environment: DevEnvironmentView } | { ok: false; error: string };

/**
 * Ambientes de código do usuário (Configurações > Conexões). Segredos são
 * write-only: a lista traz só os nomes; ao salvar, os digitados vão em lote
 * para a API depois do ambiente.
 */
export function useDevEnvironments(enabled = true) {
	const [environments, setEnvironments] = useState<DevEnvironmentView[]>([]);
	const [secretsAvailable, setSecretsAvailable] = useState(true);
	const [defaultApprovalMode, setDefaultApprovalMode] = useState<DevApprovalMode | null>(null);
	const [verifierEnabled, setVerifierEnabled] = useState(true);
	const [loading, setLoading] = useState(enabled);
	const [error, setError] = useState<string | null>(null);
	const environmentsRef = useRef<DevEnvironmentView[]>([]);
	environmentsRef.current = environments;

	const reload = useCallback(async () => {
		setLoading(true);
		try {
			const result = await listDevEnvironments();
			setEnvironments(result.environments);
			setSecretsAvailable(result.secretsAvailable);
			setDefaultApprovalMode(result.defaultApprovalMode ?? null);
			setVerifierEnabled(result.verifierEnabled ?? true);
			setError(null);
		} catch (cause) {
			setError(envErrorMessage(cause));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (enabled) void reload();
	}, [enabled, reload]);

	const replace = useCallback((env: DevEnvironmentView) => {
		setEnvironments((current) => {
			const exists = current.some((item) => item.id === env.id);
			const next = exists ? current.map((item) => (item.id === env.id ? env : item)) : [...current, env];
			return next.sort((a, b) => a.repo.localeCompare(b.repo));
		});
	}, []);

	const save = useCallback(
		async (editingId: string | null, form: DevEnvForm): Promise<SaveEnvironmentResult> => {
			let env: DevEnvironmentView;
			// Se um envio anterior criou o ambiente mas os segredos falharam, tentar de novo atualiza em vez de criar (409).
			const repo = normalizeEnvRepo(form.repo);
			const targetId = editingId ?? (repo ? environmentsRef.current.find((item) => item.repo === repo)?.id : undefined) ?? null;
			try {
				env = targetId ? await updateDevEnvironment(targetId, inputFromForm(form)) : await createDevEnvironment(inputFromForm(form));
			} catch (cause) {
				return { ok: false, error: envErrorMessage(cause) };
			}
			replace(env);
			const entries = parseEnvPaste(form.secretsText).entries.map(({ name, value }) => ({ name, value }));
			if (entries.length > 0) {
				try {
					env = await setDevEnvironmentSecrets(env.id, entries);
					replace(env);
				} catch (cause) {
					return { ok: false, error: activeT("errors.envSavedSecretsFailed", { detail: envErrorMessage(cause) }) };
				}
			}
			return { ok: true, environment: env };
		},
		[replace],
	);

	const remove = useCallback(async (id: string): Promise<string | null> => {
		try {
			await deleteDevEnvironment(id);
			setEnvironments((current) => current.filter((item) => item.id !== id));
			return null;
		} catch (cause) {
			return envErrorMessage(cause);
		}
	}, []);

	/** "Limpar cache do ambiente": devolve o erro, ou se havia cache para apagar. */
	const clearCache = useCallback(async (id: string): Promise<{ error?: string; cleared?: boolean }> => {
		try {
			const result = await clearDevEnvironmentCache(id);
			return { cleared: result.cleared };
		} catch (cause) {
			return { error: envErrorMessage(cause) };
		}
	}, []);

	const removeSecret = useCallback(
		async (id: string, name: string): Promise<{ environment?: DevEnvironmentView; error?: string }> => {
			try {
				const env = await deleteDevEnvironmentSecret(id, name);
				replace(env);
				return { environment: env };
			} catch (cause) {
				return { error: envErrorMessage(cause) };
			}
		},
		[replace],
	);

	/** Padrão da conta: otimista, volta ao anterior se falhar. */
	const changeDefaultApproval = useCallback(async (mode: DevApprovalMode): Promise<string | null> => {
		const previous = defaultApprovalMode;
		setDefaultApprovalMode(mode);
		try {
			await setDevApprovalDefault(mode);
			return null;
		} catch (cause) {
			setDefaultApprovalMode(previous);
			return envErrorMessage(cause);
		}
	}, [defaultApprovalMode]);

	/** Verificador inteligente: otimista, volta ao anterior se falhar. */
	const changeVerifier = useCallback(async (enabled: boolean): Promise<string | null> => {
		const previous = verifierEnabled;
		setVerifierEnabled(enabled);
		try {
			await setDevVerifier(enabled);
			return null;
		} catch (cause) {
			setVerifierEnabled(previous);
			return envErrorMessage(cause);
		}
	}, [verifierEnabled]);

	return { environments, secretsAvailable, defaultApprovalMode, changeDefaultApproval, verifierEnabled, changeVerifier, loading, error, reload, save, remove, removeSecret, clearCache };
}

/** Quantos ambientes o usuário tem (lista mobile); `undefined` enquanto carrega. */
export function useDevEnvironmentsCount(): number | undefined {
	const [count, setCount] = useState<number | undefined>(undefined);
	useEffect(() => {
		let cancelled = false;
		listDevEnvironments()
			.then((result) => {
				if (!cancelled) setCount(result.environments.length);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);
	return count;
}
