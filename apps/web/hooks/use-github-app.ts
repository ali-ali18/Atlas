"use client";

import { useCallback, useEffect, useState } from "react";
import {
	getGithubAppStatus,
	refreshGithubAppInstallation,
	removeGithubApp,
	removeGithubAppInstallation,
	saveGithubWriteSettings,
	type GithubAppStatus,
	type GithubWriteSettingsPatch,
} from "@/lib/atlas-api";
import { githubNoticeFromSearch, stripGithubParams, type GithubNotice } from "@/components/settings/github-app-state";

function messageOf(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * GitHub App: estado (sem segredos), atualizar/desvincular instalação e remover o app (dono).
 * Lê e limpa o retorno do GitHub (`?github=` / `?github_error=`) uma única vez.
 */
export function useGithubApp(enabled: boolean) {
	const [status, setStatus] = useState<GithubAppStatus | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<GithubNotice | null>(null);

	const load = useCallback(async () => {
		try {
			setStatus(await getGithubAppStatus());
			setError(null);
		} catch (cause) {
			setError(messageOf(cause, "Não foi possível carregar o GitHub."));
		}
	}, []);

	useEffect(() => {
		if (!enabled) return;
		void load();
		const found = githubNoticeFromSearch(window.location.search);
		if (found) {
			setNotice(found);
			window.history.replaceState(
				null,
				"",
				`${window.location.pathname}${stripGithubParams(window.location.search)}${window.location.hash}`,
			);
		}
	}, [enabled, load]);

	const run = useCallback(
		async (key: string, action: () => Promise<void>, failure: string) => {
			setBusy(key);
			setError(null);
			try {
				await action();
				await load();
			} catch (cause) {
				setError(messageOf(cause, failure));
			} finally {
				setBusy(null);
			}
		},
		[load],
	);

	return {
		status,
		busy,
		error,
		notice,
		dismissNotice: () => setNotice(null),
		refresh: (id: string) => run(id, async () => void (await refreshGithubAppInstallation(id)), "Não foi possível atualizar."),
		unlink: (id: string) => run(id, () => removeGithubAppInstallation(id), "Não foi possível desvincular."),
		saveWriteSettings: (patch: GithubWriteSettingsPatch) => run("write", async () => void (await saveGithubWriteSettings(patch)), "Não foi possível salvar."),
		removeApp: () => run("app", removeGithubApp, "Não foi possível remover o app."),
	};
}
