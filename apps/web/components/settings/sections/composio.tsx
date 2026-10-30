"use client";

import { useState } from "react";
import type { ComposioConnectedAppView, ComposioStatusView, ComposioToolkitView } from "@workspace/shared";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { ComposioKeyForm } from "../composio-key-form";
import { ComposioPagerBar } from "../composio-pager";
import { ExternalLinkIcon, KeyRoundIcon, SearchIcon, UnplugIcon } from "lucide-react";
import { ComposioAppIcon } from "@/components/ai-elements/connectors/composio-app-icon";
import { useComposio } from "@/hooks/use-composio";
import {
	COMPOSIO_SITE_URL,
	availableToolkits,
	composioNoAuthBadge,
	composioConnectLabel,
	composioDisconnectLabel,
	composioKeyCaption,
	composioViewState,
	nativeToolkitNote,
	type ComposioPager,
} from "../composio-state";
import { SettingRow, SettingsGroup } from "../setting-row";
import { useTranslations } from "@/lib/i18n/provider";

export type ComposioSettingsViewProps = {
	status: ComposioStatusView | null;
	toolkits: readonly ComposioToolkitView[];
	connections: readonly ComposioConnectedAppView[];
	search: string;
	/** `"key"`, o slug do app ou o id da conta em andamento. */
	busy: string | null;
	error?: string | null;
	listError?: string | null;
	onSaveKey: (apiKey: string) => void;
	onRemoveKey: () => void;
	onSearch: (value: string) => void;
	onConnect: (slug: string, noAuth?: boolean) => void;
	onDisconnect: (accountId: string) => void;
	/** Só a chave: a lista de apps mora na aba Apps do Marketplace. */
	hideApps?: boolean;
	/** Paginação do catálogo (opcional; sem ela só a primeira página aparece). */
	paging?: {
		pager: ComposioPager;
		hasNext: boolean;
		totalItems: number | null;
		loading: boolean;
		onPrev: () => void;
		onNext: () => void;
	};
};

function KeyRow(props: ComposioSettingsViewProps) {
	const translator = useTranslations();
	const { t } = translator;
	const { status, busy, onSaveKey, onRemoveKey } = props;
	const [confirm, setConfirm] = useState(false);
	const on = status?.configured === true;
	return (
		<>
			<SettingRow
				caption={
					<>
						{on && status ? <p className="text-xs text-muted-foreground">{composioKeyCaption(status, translator)}</p> : null}
						{status && !status.secretBoxReady ? (
							<p className="text-xs text-destructive" role="alert">
								{t("settings.composio.vaultMissing")}
							</p>
						) : null}
						{props.error ? (
							<p className="text-xs text-destructive" role="alert">
								{props.error}
							</p>
						) : null}
					</>
				}
				control={on ? "inline" : "field"}
				wrap={!on}
				description={
					on ? (
						t("settings.composio.removeHint")
					) : (
						<>
							{t("settings.composio.optionalHint")}{" "}
							<a
								className="inline-flex items-center gap-1 underline underline-offset-2"
								href={COMPOSIO_SITE_URL}
								rel="noopener noreferrer"
								target="_blank"
							>
								{t("settings.composio.createKey")}
								<ExternalLinkIcon aria-hidden className="size-3" />
							</a>
						</>
					)
				}
				htmlFor={on ? undefined : "settings-composio-key"}
				icon={KeyRoundIcon}
				label={t("settings.composio.keyLabel")}
			>
				{on ? (
					<Button disabled={busy === "key"} onClick={() => setConfirm(true)} size="sm" variant="destructive">
						{t("settings.composio.removeKey")}
					</Button>
				) : status ? (
					<ComposioKeyForm
						busy={busy === "key"}
						disabled={!status.secretBoxReady}
						inputId="settings-composio-key"
						onSave={onSaveKey}
					/>
				) : null}
			</SettingRow>
			<AlertDialog onOpenChange={setConfirm} open={confirm}>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>{t("settings.composio.removeTitle")}</AlertDialogTitle>
						<AlertDialogDescription>{t("settings.composio.removeBody")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("settings.composio.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								setConfirm(false);
								onRemoveKey();
							}}
						>
							{t("settings.composio.remove")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

/** Tela pura da seção (renderiza em teste estático): sem chave, só a linha da chave. */
export function ComposioSettingsView(props: ComposioSettingsViewProps) {
	const translator = useTranslations();
	const { t } = translator;
	const { status, toolkits, connections, search, busy, listError, onSearch, onConnect, onDisconnect } = props;
	const state = composioViewState(status);
	if (state === "loading") return null;
	const available = availableToolkits(toolkits, connections);
	return (
		<SettingsGroup>
			<KeyRow {...props} />
			{state === "on" && !props.hideApps ? (
				<>
					{connections.map((app) => (
						<SettingRow
							control="inline"
							description={t("settings.composio.appDescription", { state: app.noAuth ? t("settings.composio.appStateOn") : t("settings.composio.appStateConnected") })}
							icon={({ className }) => <ComposioAppIcon className={className} logo={toolkits.find((item) => item.slug === app.toolkit)?.logo} />}
							key={app.id}
							label={app.toolkitName}
						>
							<span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{app.noAuth ? t("settings.composio.appStateOn") : t("settings.composio.appStateConnected")}</span>
							<Button
								aria-label={`${composioDisconnectLabel(app.noAuth, translator)} ${app.toolkitName}`}
								disabled={busy !== null}
								onClick={() => onDisconnect(app.id)}
								size="sm"
								variant="outline"
							>
								<UnplugIcon aria-hidden />
								{busy === app.id ? t("settings.composio.wait") : composioDisconnectLabel(app.noAuth, translator)}
							</Button>
						</SettingRow>
					))}
					<SettingRow
						control="field"
						wrap
						description={t("settings.composio.addAppHint")}
						htmlFor="settings-composio-search"
						icon={SearchIcon}
						label={t("settings.composio.addApp")}
					>
						<Input
							id="settings-composio-search"
							onChange={(event) => onSearch(event.target.value)}
							placeholder={t("settings.composio.searchApps")}
							type="search"
							value={search}
						/>
					</SettingRow>
					{listError ? (
						<p className="py-3 text-xs text-destructive" role="alert">
							{listError}
						</p>
					) : null}
					{available.map((toolkit) => (
						<SettingRow
							caption={
								nativeToolkitNote(toolkit, translator) ? (
									<p className="text-xs text-muted-foreground">{nativeToolkitNote(toolkit, translator)}</p>
								) : null
							}
							control="inline"
							description={toolkit.description ?? undefined}
							icon={({ className }) => <ComposioAppIcon className={className} logo={toolkit.logo} />}
							key={toolkit.slug}
							label={toolkit.name}
						>
							{toolkit.noAuth ? (
								<span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{composioNoAuthBadge(translator)}</span>
							) : null}
							<Button
								aria-label={`${composioConnectLabel(toolkit.noAuth, translator)} ${toolkit.name}`}
								disabled={busy !== null}
								onClick={() => onConnect(toolkit.slug, toolkit.noAuth)}
								size="sm"
								variant="secondary"
							>
								{busy === toolkit.slug ? t("settings.composio.wait") : composioConnectLabel(toolkit.noAuth, translator)}
							</Button>
						</SettingRow>
					))}
					{!listError && available.length === 0 ? (
						<p className="py-3 text-sm text-muted-foreground">{t("settings.composio.none")}</p>
					) : null}
					{props.paging ? (
						<ComposioPagerBar
							disabled={props.paging.loading}
							hasNext={props.paging.hasNext}
							onNext={props.paging.onNext}
							onPrev={props.paging.onPrev}
							pager={props.paging.pager}
							totalItems={props.paging.totalItems}
						/>
					) : null}
				</>
			) : null}
		</SettingsGroup>
	);
}

/** Seção Composio: chave própria do usuário, apps disponíveis e conectados. */
export function ComposioSettings({ hideApps = false }: { hideApps?: boolean } = {}) {
	const composio = useComposio(true);
	return (
		<ComposioSettingsView
			hideApps={hideApps}
			busy={composio.busy}
			connections={composio.connections}
			error={composio.error}
			listError={composio.listError}
			onConnect={(slug, noAuth) => void composio.connect(slug, { noAuth })}
			onDisconnect={(id) => void composio.disconnect(id)}
			onRemoveKey={() => void composio.removeKey()}
			onSaveKey={(key) => void composio.saveKey(key)}
			paging={{
				pager: composio.pager,
				hasNext: composio.nextCursor !== null,
				totalItems: composio.totalItems,
				loading: composio.loading,
				onPrev: composio.prevPage,
				onNext: composio.nextPage,
			}}
			onSearch={composio.setSearch}
			search={composio.search}
			status={composio.status}
			toolkits={composio.toolkits}
		/>
	);
}
