"use client";

import { useCallback, useEffect, useState } from "react";
import {
	ActivityIcon,
	ShieldCheckIcon,
	BellIcon,
	BotIcon,
	ChartColumnIcon,
	BrainIcon,
	CreditCardIcon,
	GaugeIcon,
	MonitorIcon,
	PlugIcon,
	SettingsIcon,
	KeyRoundIcon,
	SparklesIcon,
	UserIcon,
	type LucideIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { DialogTitle } from "@workspace/ui/components/dialog";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/components/ui/templates/template-4/settings-list";
import { authClient } from "@/lib/auth-client";
import { useOpenRouterModels } from "@/hooks/use-openrouter-models";
import { useUsage } from "@/hooks/use-usage";
import { useDevEnvironmentsCount } from "@/hooks/use-dev-environments";
import { useSkillsCount } from "@/hooks/use-skills-count";
import { listComposioConnections, listMcpConnections } from "@/lib/atlas-api";
import { JEV_FEATURES, type EffectiveAccountConfig } from "@workspace/shared";
import { runUnlessUnsaved } from "@/lib/unsaved-guard";
import { navSectionLabel, type SettingsNavId, type SettingsSectionId } from "./settings-registry";
import { mobileSettingsGroups, type MobileSettingsSummary } from "./settings-mobile-model";
import { modelLabel } from "./models-state";
import { UserAvatar } from "@workspace/ui/components/gradient-avatar";
import { useTranslations } from "@/lib/i18n/provider";

/** Conexões ativas: apps Composio + conexões MCP conectadas. Falha em uma fonte conta como 0 nela. */
function useConnectionsCount(): number | undefined {
	const [count, setCount] = useState<number | undefined>(undefined);
	useEffect(() => {
		let cancelled = false;
		Promise.all([listComposioConnections().catch(() => []), listMcpConnections().catch(() => [])]).then(([apps, mcp]) => {
			if (!cancelled) setCount(apps.length + mcp.filter((c) => c.status === "connected").length);
		});
		return () => {
			cancelled = true;
		};
	}, []);
	return count;
}

function reviewModeOf(effective: EffectiveAccountConfig | undefined): MobileSettingsSummary["reviewMode"] {
	if (!effective) return undefined;
	const modes = JEV_FEATURES.map((feature) => effective.jev.features[feature].value);
	if (modes.includes("on")) return "on";
	return modes.includes("shadow") ? "shadow" : "off";
}

const ROW_ICONS: Record<SettingsNavId, LucideIcon> = {
	conta: UserIcon,
	geral: SettingsIcon,
	provedores: CreditCardIcon,
	modelos: BrainIcon,
	execucao: GaugeIcon,
	bots: BotIcon,
	notificacoes: BellIcon,
	computador: MonitorIcon,
	conexoes: PlugIcon,
	cofre: KeyRoundIcon,
	habilidades: SparklesIcon,
	uso: ChartColumnIcon,
	revisao: ShieldCheckIcon,
	diagnostico: ActivityIcon,
};

const HISTORY_FLAG = "atlasSettingsPage";

/**
 * Lista de configurações em tela cheia (mobile) com pilha lista → sub-página.
 * Abrir uma sub-página empilha um estado no histórico: o voltar do navegador /
 * Android fecha a sub-página; o botão do cabeçalho faz o mesmo.
 */
export function SettingsMobile({
	initialPage,
	summary,
	onClose,
	renderSection,
}: {
	/** Sub-página já aberta (ex.: `?settings=avancado`); `null` = lista. */
	initialPage: SettingsSectionId | null;
	summary: { defaultModel?: string; chatgptEnabled?: boolean; effective?: EffectiveAccountConfig };
	onClose: () => void;
	renderSection: (section: SettingsSectionId) => React.ReactNode;
}) {
	const translator = useTranslations();
	const { t } = translator;
	const themeLabels: Record<string, string> = {
		light: t("settings.general.themeLight"),
		dark: t("settings.general.themeDark"),
		system: t("settings.general.themeSystem"),
	};
	const [page, setPage] = useState<SettingsSectionId | null>(initialPage);
	const { theme } = useTheme();
	const { data: session } = authClient.useSession();
	const { models } = useOpenRouterModels();
	const connectionsCount = useConnectionsCount();
	const environmentsCount = useDevEnvironmentsCount();
	const skillsCount = useSkillsCount();
	const usage = useUsage("7d");
	const name = session?.user.name || t("settings.myAccount");
	const email = session?.user.email ?? "";

	useEffect(() => {
		function onPop(event: PopStateEvent) {
			if (!event.state?.[HISTORY_FLAG]) setPage(null);
		}
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	const open = useCallback((id: SettingsSectionId) => {
		window.history.pushState({ [HISTORY_FLAG]: true }, "");
		setPage(id);
	}, []);

	function back() {
		runUnlessUnsaved(() => {
			if (window.history.state?.[HISTORY_FLAG]) window.history.back();
			else setPage(null);
		});
	}

	if (page) {
		const title = navSectionLabel(t, page);
		return (
			<SettingsPage
				backLabel={t("settings.back")}
				onBack={back}
				title={title}
				titleSlot={(text) => <DialogTitle className="truncate font-heading text-base font-semibold">{text}</DialogTitle>}
			>
				<div data-slot="settings-subpage">{renderSection(page)}</div>
			</SettingsPage>
		);
	}

	const groups = mobileSettingsGroups({
		defaultModel: summary.defaultModel ? modelLabel(summary.defaultModel, models) : undefined,
		chatgptEnabled: summary.chatgptEnabled,
		theme: theme ? themeLabels[theme] : undefined,
		browserAuto: summary.effective?.sandboxAutoStart.value,
		connectionsCount,
		environmentsCount,
		skillsCount,
		usageCostUsd: usage.data ? usage.data.totals.costUsd : undefined,
		reviewMode: reviewModeOf(summary.effective),
	}, undefined, translator);
	return (
		<SettingsPage
			backLabel={t("settings.close")}
			icon="close"
			onBack={() => runUnlessUnsaved(onClose)}
			title={t("settings.title")}
			titleSlot={(text) => <DialogTitle className="truncate font-heading text-base font-semibold">{text}</DialogTitle>}
		>
			<div className="flex flex-col gap-4">
				<SettingsGroup>
					<SettingsRow
						leading={
							<UserAvatar email={email} image={session?.user.image} name={session?.user.name} seed={email || name} />
						}
						onClick={() => open("conta")}
						secondary={email || undefined}
						title={name}
					/>
				</SettingsGroup>
				{groups.map((group) => (
					<SettingsGroup key={group.id} label={group.label}>
						{group.rows.map((item) => (
							<SettingsRow
								icon={ROW_ICONS[item.id]}
								key={item.id}
								onClick={() => open(item.id)}
								secondary={item.secondary}
								title={item.title}
							/>
						))}
					</SettingsGroup>
				))}
			</div>
		</SettingsPage>
	);
}
