"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountConfigPatch, AccountSettingsResponse } from "@workspace/shared";
import { useT } from "@/lib/i18n/provider";
import { getAccountSettings, patchAccountSettings } from "@/lib/atlas-api";
import {
	type SaveStatus,
	commitSettingsChange,
} from "@/components/settings/account-settings-state";

const SAVED_VISIBLE_MS = 2000;

/**
 * Configurações da conta (`GET`/`PATCH /v1/settings`). Cada controle salva na
 * hora: mostra a escolha na hora (otimista), troca pela resposta do servidor
 * e, se falhar, volta ao valor anterior com o erro em pt-BR.
 * Só carrega com `enabled` (modal aberto).
 */
export function useAccountSettings(enabled: boolean) {
	const t = useT();
	const [view, setView] = useState<AccountSettingsResponse | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [status, setStatus] = useState<SaveStatus>("idle");
	const [saveError, setSaveError] = useState<string | null>(null);
	const viewRef = useRef<AccountSettingsResponse | null>(null);
	const requestRef = useRef(0);
	const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const apply = useCallback((next: AccountSettingsResponse | null) => {
		viewRef.current = next;
		setView(next);
	}, []);

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		setLoadError(null);
		getAccountSettings()
			.then((next) => {
				if (!cancelled) apply(next);
			})
			.catch(() => {
				if (!cancelled) setLoadError(t("settings.loadError"));
			});
		return () => {
			cancelled = true;
		};
	}, [enabled, apply, t]);

	useEffect(
		() => () => {
			if (savedTimer.current) clearTimeout(savedTimer.current);
		},
		[],
	);

	const save = useCallback(
		async (patch: AccountConfigPatch, extra?: { sandboxAutoStart?: boolean }) => {
			const current = viewRef.current;
			if (!current) return;
			const request = ++requestRef.current;
			if (savedTimer.current) clearTimeout(savedTimer.current);
			setStatus("saving");
			setSaveError(null);
			const result = await commitSettingsChange({
				view: current,
				patch,
				extra,
				send: patchAccountSettings,
				onOptimistic: apply,
				t,
			});
			// Resposta de um PATCH antigo não sobrescreve uma escolha mais nova.
			if (request !== requestRef.current) return;
			apply(result.view);
			if (result.ok) {
				setStatus("saved");
				savedTimer.current = setTimeout(() => setStatus("idle"), SAVED_VISIBLE_MS);
			} else {
				setStatus("error");
				setSaveError(result.error);
			}
		},
		[apply, t],
	);

	return { view, loadError, status, saveError, save };
}
