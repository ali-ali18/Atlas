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
import { activeT } from "@/lib/i18n/active";

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
			setError(messageOf(cause, activeT("errors.loadGithub")));
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
		refresh: (id: string) => run(id, async () => void (await refreshGithubAppInstallation(id)), activeT("errors.githubRefresh")),
		unlink: (id: string) => run(id, () => removeGithubAppInstallation(id), activeT("errors.githubUnlink")),
		saveWriteSettings: (patch: GithubWriteSettingsPatch) => run("write", async () => void (await saveGithubWriteSettings(patch)), activeT("errors.save")),
		removeApp: () => run("app", removeGithubApp, activeT("errors.githubRemoveApp")),
	};
}
