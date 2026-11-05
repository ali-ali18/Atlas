import type { AutonomyLevel } from "@workspace/shared";
import * as React from "react";
import { useAtlasSession } from "./atlas-session";
import { isUnauthorized } from "./chat-api";
import { fetchAccountSettings, fetchAutonomyLevel, fetchUsage, saveAccountSetting, saveAutonomyLevel, type SettingsChange } from "./settings-api";
import { applySettingsChange, revertSettings } from "./settings-change";
import { costLabel, friendlyError, SUMMARY_USAGE_PERIOD } from "./settings-format";
import type { AccountSettings } from "./settings-parse";
import { deviceTimeZone } from "./timezone";

export type AccountSettingsState = {
	settings: AccountSettings | null;
	level: AutonomyLevel | null;
	/** Custo dos últimos 30 dias, já em texto, para a linha "Uso"; `null` enquanto não chegou (ou se falhou: a linha só some o valor). */
	usageSummary: string | null;
	/** Falha de carregar a conta (a tela oferece "Tentar de novo"); falha de salvar vai em `notice`. */
	loadFailed: boolean;
	/** Aviso amigável da última escrita que o servidor não aceitou. */
	notice: string | null;
	dismissNotice: () => void;
	reload: () => void;
	/** Escrita otimista: mostra já e desfaz o campo se o servidor recusar. `silent` não avisa (sincronização automática do fuso). */
	change: (change: SettingsChange, options?: { silent?: boolean }) => void;
	setLevel: (level: AutonomyLevel) => void;
};

/** Estado das Configurações do bot (fuso, idioma, navegador, permissões) e o resumo de uso, lidos do servidor ao abrir a tela. */
export function useAccountSettings(): AccountSettingsState {
	const { apiFetch, signOut } = useAtlasSession();
	const [settings, setSettings] = React.useState<AccountSettings | null>(null);
	const [level, setLevelState] = React.useState<AutonomyLevel | null>(null);
	const [usageSummary, setUsageSummary] = React.useState<string | null>(null);
	const [loadFailed, setLoadFailed] = React.useState(false);
	const [notice, setNotice] = React.useState<string | null>(null);
	const settingsRef = React.useRef<AccountSettings | null>(null);
	settingsRef.current = settings;
	const levelRef = React.useRef<AutonomyLevel | null>(null);
	levelRef.current = level;
	const alive = React.useRef(true);
	React.useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	const fail = React.useCallback(
		(error: unknown, action: "save" | "load") => {
			if (isUnauthorized(error)) {
				void signOut();
				return;
			}
			if (alive.current) setNotice(friendlyError(error, action));
		},
		[signOut],
	);

	const [attempt, setAttempt] = React.useState(0);
	React.useEffect(() => {
		let cancelled = false;
		void attempt;
		setLoadFailed(false);
		void Promise.allSettled([fetchAccountSettings(apiFetch), fetchAutonomyLevel(apiFetch), fetchUsage(apiFetch, SUMMARY_USAGE_PERIOD, deviceTimeZone() ?? "UTC")]).then(([account, autonomy, usage]) => {
			if (cancelled) return;
			if (account.status === "fulfilled") setSettings(account.value);
			else if (isUnauthorized(account.reason)) void signOut();
			else setLoadFailed(true);
			if (autonomy.status === "fulfilled") setLevelState(autonomy.value);
			if (usage.status === "fulfilled") setUsageSummary(costLabel(usage.value.totals));
		});
		return () => {
			cancelled = true;
		};
	}, [apiFetch, signOut, attempt]);

	const change = React.useCallback(
		(next: SettingsChange, options: { silent?: boolean } = {}) => {
			const before = settingsRef.current;
			if (!before) return;
			setSettings((current) => (current ? applySettingsChange(current, next) : current));
			void saveAccountSetting(apiFetch, next).then(
				(saved) => {
					// O servidor é a verdade, mas só no campo salvo: outro campo em voo continua como está.
					if (alive.current) setSettings((current) => (current ? { ...current, ...pick(saved, next) } : current));
				},
				(error) => {
					if (alive.current) setSettings((current) => (current ? revertSettings(current, before, next) : current));
					if (options.silent) {
						if (isUnauthorized(error)) void signOut();
					} else fail(error, "save");
				},
			);
		},
		[apiFetch, fail, signOut],
	);

	const setLevel = React.useCallback(
		(next: AutonomyLevel) => {
			const previous = levelRef.current;
			setLevelState(next);
			void saveAutonomyLevel(apiFetch, next).then(
				(saved) => {
					if (alive.current) setLevelState(saved);
				},
				(error) => {
					if (alive.current) setLevelState(previous);
					fail(error, "save");
				},
			);
		},
		[apiFetch, fail],
	);

	const dismissNotice = React.useCallback(() => setNotice(null), []);
	const reload = React.useCallback(() => setAttempt((value) => value + 1), []);
	return { settings, level, usageSummary, loadFailed, notice, dismissNotice, reload, change, setLevel };
}

/** Do que o servidor devolveu, só o campo que esta mudança tocou. */
function pick(saved: AccountSettings, change: SettingsChange): Partial<AccountSettings> {
	if ("timezone" in change) return { timezone: saved.timezone };
	if ("botLanguage" in change) return { botLanguage: saved.botLanguage };
	return { sandboxAutoStart: saved.sandboxAutoStart };
}
