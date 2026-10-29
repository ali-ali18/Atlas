"use client";

import { XIcon } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@workspace/ui/components/dialog";
import { useIsMobile } from "@workspace/ui/hooks/use-mobile";
import { useT } from "@/lib/i18n/provider";
import { useAccountSettings } from "@/hooks/use-account-settings";
import { runUnlessUnsaved } from "@/lib/unsaved-guard";
import {
	type SettingsShortcutId,
	DEFAULT_SETTINGS_SECTION,
	hiddenSettingsItems,
	isItemVisible,
	navSectionLabel,
} from "./settings-registry";
import { SectionContent } from "./sections/panes";
import { SettingsMobile } from "./settings-mobile";
import { SettingsShell } from "./settings-shell";
import { useSettingsSection } from "./settings-url";

/**
 * Título da seção (17px, medium) e o botão de fechar redondo no canto, como no Grok
 * (Esc e foco preso vêm do Dialog do ui).
 */
export function SettingsHeader({ title }: { title: string }) {
	const t = useT();
	return (
		<div className="flex shrink-0 items-center justify-between gap-3 px-8 pt-8 pb-1.5" data-slot="settings-header">
			<DialogTitle className="px-2 font-heading text-[17px] leading-6 font-medium">{title}</DialogTitle>
			<DialogClose
				render={
					<Button
						aria-label={t("settings.close")}
						className="absolute top-2.5 right-2.5 size-8 rounded-full text-muted-foreground hover:text-foreground"
						size="icon-sm"
						variant="ghost"
					/>
				}
			>
				<XIcon aria-hidden />
			</DialogClose>
		</div>
	);
}

/**
 * Modal de configurações da conta. A seção aberta mora na URL
 * (`?settings=geral`): recarregar mantém, fechar remove o parâmetro.
 * `onShortcut` abre as telas que já existem (Marketplace e MCP personalizado).
 */
export function SettingsDialog({ onShortcut }: { onShortcut: (id: SettingsShortcutId) => void }) {
	const t = useT();
	const { section, setSection } = useSettingsSection();
	const account = useAccountSettings(section !== null);
	const hidden = hiddenSettingsItems(account.view?.capabilities);
	const isMobile = useIsMobile();

	function shortcut(id: SettingsShortcutId) {
		setSection(null);
		onShortcut(id);
	}

	return (
		<Dialog
			onOpenChange={(open) => {
				// Esc / clique fora / X: com alterações não salvas no editor, pergunta antes de fechar.
				if (!open) runUnlessUnsaved(() => setSection(null));
			}}
			open={section !== null}
		>
			<DialogContent
				className={
					isMobile
						? "top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none"
						: "flex h-[min(700px,calc(100dvh-96px))] w-[min(900px,calc(100vw-40px))] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[900px]"
				}
				showCloseButton={false}
			>
				{section && isMobile ? (
					<>
						<DialogDescription className="sr-only">{t("settings.description")}</DialogDescription>
						<SettingsMobile
							// O menu abre em "geral" por padrão; no mobile isso significa "a lista".
							initialPage={section === DEFAULT_SETTINGS_SECTION ? null : section}
							onClose={() => setSection(null)}
							renderSection={(next) => (
								<SectionContent
									account={account}
									isVisible={(id) => !hidden.has(id)}
									onShortcut={shortcut}
									section={next}
								/>
							)}
							summary={{
								defaultModel: account.view?.effective.models.default.value,
								chatgptEnabled: account.view?.effective.providers.chatgptEnabled.value,
								effective: account.view?.effective,
							}}
						/>
					</>
				) : section ? (
					<>
						<DialogDescription className="sr-only">{t("settings.description")}</DialogDescription>
						<SettingsShell
							header={<SettingsHeader title={navSectionLabel(t, section)} />}
							hiddenItems={hidden}
							onSectionChange={(next) => runUnlessUnsaved(() => setSection(next))}
							section={section}
						>
							{({ search }) => (
								<SectionContent
									account={account}
									isVisible={(id) => !hidden.has(id) && isItemVisible(search, section, id)}
									onShortcut={shortcut}
									section={section}
								/>
							)}
						</SettingsShell>
					</>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
