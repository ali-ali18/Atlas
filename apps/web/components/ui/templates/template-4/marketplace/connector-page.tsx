"use client"

import type { ReactNode } from "react"
import { ArrowLeftIcon, BoxIcon, CheckIcon, ExternalLinkIcon, PlugIcon } from "lucide-react"
import type { McpConnectionView } from "@workspace/shared"
import { Button } from "@workspace/ui/components/button"
import type { McpCatalogItem } from "@/lib/atlas-api"
import { accountDisplayLabel } from "@/lib/connector-accounts"
import { useTranslations } from "@/lib/i18n/provider"
import { defaultTranslator, type MessageKey, type Translator } from "@/lib/i18n/translator"
import { connectorAction } from "./connector-action"
import { AccountTabs, AccountsSection, type AccountRow } from "./connector-accounts"
import { ConnectorDetail } from "./connector-detail"

const CATEGORY_KEYS = {
	search: "marketplace.connector.category.search",
	google: "marketplace.connector.category.google",
	productivity: "marketplace.connector.category.productivity",
	creative: "marketplace.connector.category.creative",
	custom: "marketplace.connector.category.custom",
} as const satisfies Record<string, MessageKey>

const statusText = (connection: McpConnectionView, { t }: Translator) =>
	connection.status === "connected" ? t("marketplace.connector.status.connected") : connection.status === "error" ? t("marketplace.connector.status.error") : t("marketplace.connector.status.pending")

/** Linhas da seção "Contas" de um conector do catálogo (cada conexão é uma conta). */
export function mcpAccountRows(accounts: readonly McpConnectionView[], serviceName: string, currentId?: string, translator: Translator = defaultTranslator): AccountRow[] {
	return accounts.map((account) => {
		const label = accountDisplayLabel(account, accounts, translator)
		return {
			id: account.id,
			title: label ?? serviceName,
			status: statusText(account, translator),
			ok: account.status === "connected",
			needsReconnect: account.status !== "connected" && account.authType === "oauth",
			current: account.id === currentId,
			label: account.accountLabel ?? "",
		}
	})
}

export function ConnectorPage({
	entry,
	connection,
	accounts = [],
	accountBusyId,
	accountError,
	adding = false,
	icon,
	secretBoxReady,
	busy,
	onBack,
	onAction,
	onChanged,
	onDeleted,
	onManageAutonomy,
	onSelectAccount,
	onAddAccount,
	onRenameAccount,
	onReconnectAccount,
	onDisconnectAccount,
}: {
	entry?: McpCatalogItem
	connection?: McpConnectionView
	/** Todas as contas deste conector (catálogo); a seção "Contas" aparece quando há alguma. */
	accounts?: McpConnectionView[]
	accountBusyId?: string | null
	accountError?: string | null
	/** Login de outra conta em andamento. */
	adding?: boolean
	onSelectAccount?: (id: string) => void
	onAddAccount?: () => void
	onRenameAccount?: (id: string, label: string) => Promise<void> | void
	onReconnectAccount?: (id: string) => void
	onDisconnectAccount?: (id: string) => Promise<void> | void
	icon: ReactNode
	secretBoxReady: boolean
	busy: boolean
	/** Sem `onBack` não mostra o botão (o cabeçalho da página do Marketplace já tem o voltar). */
	onBack?: () => void
	onAction: () => void
	onChanged: (connection: McpConnectionView) => void
	onDeleted: (id: string) => void
	onManageAutonomy?: (connector: string) => void
}) {
	const translator = useTranslations()
	const { t, tn } = translator
	const action = connectorAction({ entry, connection, secretBoxReady, busy, translator })
	// Personalizado com OAuth expirado também ganha "Reconectar".
	const showAction = !!entry || (connection?.authType === "oauth" && connection.status !== "connected")
	const skills = entry?.skills ?? []
	const appCount = Math.max(accounts.length, 1)
	const showAccounts = !!entry && accounts.length > 0 && !!onAddAccount && !!onRenameAccount && !!onDisconnectAccount

	return (
		<div className="min-w-0 space-y-6 pb-2">
			{onBack ? (
				<Button className="-ml-2" onClick={onBack} size="sm" type="button" variant="ghost">
					<ArrowLeftIcon className="size-4" /> {t("marketplace.backToMarketplace")}
				</Button>
			) : null}
			<div className="flex flex-wrap items-center gap-4">
				<div className="[&>span]:!size-16 [&>span]:!rounded-2xl [&_img]:!size-9 [&_svg]:!size-8">
					{icon}
				</div>
				<div className="min-w-0 flex-1">
					<h2 className="text-xl font-semibold">{entry?.name ?? connection?.name ?? t("marketplace.connector.customName")}</h2>
					{entry ? (
						<a className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" href={entry.sourceUrl} rel="noopener noreferrer" target="_blank">
							{t("marketplace.connector.viewSource")} <ExternalLinkIcon className="size-3" />
						</a>
					) : (
						<p className="break-all text-xs text-muted-foreground">{connection?.url}</p>
					)}
				</div>
				{showAction && (
					<Button disabled={action.disabled} onClick={onAction} title={action.title} type="button" variant={action.connected ? "secondary" : "default"}>
						{action.connected ? <CheckIcon className="size-4" /> : null}
						{action.label}
					</Button>
				)}
			</div>
			{entry?.longDescription && <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{entry.longDescription}</p>}
			{showAccounts && entry ? (
				<AccountsSection
					accounts={mcpAccountRows(accounts, entry.name, connection?.id, translator)}
					adding={adding}
					busyId={accountBusyId}
					error={accountError}
					oauthHint={entry.authType === "oauth"}
					onAdd={onAddAccount!}
					onDisconnect={onDisconnectAccount!}
					onReconnect={onReconnectAccount}
					onRename={onRenameAccount!}
					onSelect={accounts.length > 1 ? onSelectAccount : undefined}
				/>
			) : null}
			{entry && (
				<>
					<section className="space-y-2">
						<h3 className="text-sm font-semibold">{t("marketplace.connector.apps", { count: appCount })}</h3>
						<div className="divide-y rounded-xl border bg-muted/20">
							{(accounts.length > 0 ? accounts : connection ? [connection] : [undefined]).map((account) => (
								<div className="flex items-center gap-3 p-4" key={account?.id ?? "entry"}>
									<PlugIcon className="size-5 shrink-0 text-muted-foreground" />
									<div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{(account && accounts.length > 1 ? accountDisplayLabel(account, accounts, translator) : null) ?? entry.name}</p><p className="text-xs text-muted-foreground">{t("marketplace.connector.connector")}</p></div>
									{account && <span className="shrink-0 text-xs text-muted-foreground">{t("marketplace.connector.toolCount", { count: account.tools.length })}</span>}
								</div>
							))}
						</div>
					</section>
					{skills.length > 0 && (
						<section className="space-y-2">
							<h3 className="text-sm font-semibold">{t("marketplace.connector.skills", { count: skills.length })}</h3>
							<div className="divide-y rounded-xl border bg-muted/20">
								{skills.map((skill) => (
									<div className="flex min-w-0 items-center gap-3 p-4" key={skill.key}>
										<BoxIcon className="size-5 shrink-0 text-muted-foreground" />
										<div className="min-w-0"><p className="truncate text-sm font-medium">{skill.key} <span className="font-normal text-muted-foreground">· {skill.title}</span></p><p className="truncate text-xs text-muted-foreground" title={skill.description}>{skill.description}</p></div>
									</div>
								))}
							</div>
						</section>
					)}
					<section className="space-y-2">
						<h3 className="text-sm font-semibold">{t("marketplace.info")}</h3>
						<dl className="divide-y rounded-xl border bg-muted/20 px-4">
							<div className="flex justify-between gap-4 py-3 text-sm"><dt className="text-muted-foreground">{t("marketplace.connector.resources")}</dt><dd>{t("marketplace.connector.resourcesValue", { apps: tn("marketplace.connector.appCount", appCount), skills: skills.length === 0 ? t("marketplace.connector.skillCountNone") : tn("marketplace.connector.skillCount", skills.length) })}</dd></div>
							<div className="flex justify-between gap-4 py-3 text-sm"><dt className="text-muted-foreground">{t("marketplace.connector.developer")}</dt><dd>{entry.developer}</dd></div>
							<div className="flex justify-between gap-4 py-3 text-sm"><dt className="text-muted-foreground">{t("marketplace.category")}</dt><dd>{CATEGORY_KEYS[entry.category] ? t(CATEGORY_KEYS[entry.category]) : entry.category}</dd></div>
							<div className="flex justify-between gap-4 py-3 text-sm"><dt className="text-muted-foreground">{t("marketplace.connector.website")}</dt><dd><a className="hover:underline" href={`https://${entry.website}`} rel="noopener noreferrer" target="_blank">{entry.website} ↗</a></dd></div>
						</dl>
					</section>
				</>
			)}
			{connection && (
				<section className="space-y-3">
					<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
						<h3 className="text-sm font-semibold">{t("marketplace.connector.configuration")}</h3>
						{showAccounts && accounts.length > 1 && onSelectAccount ? (
							<AccountTabs
								accounts={mcpAccountRows(accounts, entry?.name ?? "", connection.id, translator).map(({ id, title }) => ({ id, title }))}
								label={t("marketplace.api.accountInSetup")}
								onChange={onSelectAccount}
								value={connection.id}
							/>
						) : null}
					</div>
					<div className="rounded-xl border bg-muted/20 p-4">
						<ConnectorDetail connection={connection} hideDisconnect={showAccounts} key={connection.id} onChanged={onChanged} onDeleted={onDeleted} onManageAutonomy={onManageAutonomy} />
					</div>
				</section>
			)}
		</div>
	)
}
