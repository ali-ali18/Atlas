"use client";

import { useState, type ReactNode } from "react";
import { CheckCircle2Icon, ChevronRightIcon, EllipsisVerticalIcon, ExternalLinkIcon, InfoIcon, LockIcon, PlusIcon, RefreshCwIcon, TriangleAlertIcon, UnplugIcon, XIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@workspace/ui/components/dropdown-menu";
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
import { Button, buttonVariants } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { Switch } from "@workspace/ui/components/switch";
import { cn } from "@workspace/ui/lib/utils";
import { GithubMarkIcon } from "@/components/icons/github-mark";
import { useGithubApp } from "@/hooks/use-github-app";
import {
	GITHUB_APP_INSTALL_PATH,
	GITHUB_APP_MANIFEST_START_PATH,
	type GithubAppInstallation,
	type GithubAppStatus,
	type GithubWriteSettingsPatch,
} from "@/lib/atlas-api";
import {
	githubAccountLabel,
	githubAppViewState,
	githubInstallationStatus,
	githubMissingPermissionsText,
	githubRepoCountLabel,
	githubWriteAsCaption,
	type GithubNotice,
} from "../github-app-state";
import { SettingRow, SettingsGroup } from "../setting-row";

export type GithubAppSettingsViewProps = {
	status: GithubAppStatus | null;
	busy: string | null;
	error?: string | null;
	notice?: GithubNotice | null;
	onDismissNotice?: () => void;
	onRefresh: (id: string) => void;
	onUnlink: (id: string) => void;
	onRemoveApp: () => void;
	onSaveWrite?: (patch: GithubWriteSettingsPatch) => void;
};

const NOTICE_STYLE: Record<GithubNotice["tone"], { icon: typeof InfoIcon; className: string }> = {
	success: { icon: CheckCircle2Icon, className: "text-foreground" },
	info: { icon: InfoIcon, className: "text-muted-foreground" },
	error: { icon: TriangleAlertIcon, className: "text-destructive" },
};

function NoticeRow({ notice, onDismiss }: { notice: GithubNotice; onDismiss?: () => void }) {
	const { icon: Icon, className } = NOTICE_STYLE[notice.tone];
	return (
		<div
			className={cn("flex items-start gap-2 px-3.5 py-2.5 text-body leading-[18px]", className)}
			data-slot="github-notice"
			role={notice.tone === "error" ? "alert" : "status"}
		>
			<Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
			<p className="min-w-0 flex-1">{notice.text}</p>
			{onDismiss ? (
				<button aria-label="Fechar aviso" className="rounded-sm text-muted-foreground hover:text-foreground" onClick={onDismiss} type="button">
					<XIcon aria-hidden className="size-4" />
				</button>
			) : null}
		</div>
	);
}

function LinkButton({
	href,
	children,
	variant = "secondary",
	external = false,
	label,
}: {
	href: string;
	children: ReactNode;
	variant?: "secondary" | "outline" | "ghost" | "default";
	external?: boolean;
	label?: string;
}) {
	return (
		<a
			aria-label={label}
			className={buttonVariants({ variant, size: "sm" })}
			href={href}
			{...(external ? { rel: "noopener noreferrer", target: "_blank" } : {})}
		>
			{children}
		</a>
	);
}

const REPO_PAGE = 8;

/** Repositórios da instalação: recolhido por padrão, um por linha, de 8 em 8. */
function RepoChips({ inst }: { inst: GithubAppInstallation }) {
	const [visible, setVisible] = useState(REPO_PAGE);
	if (inst.repos.length === 0) return null;
	const total = inst.repoCount ?? inst.repos.length;
	const shown = inst.repos.slice(0, visible);
	const more = inst.repos.length - shown.length;
	return (
		<Collapsible className="px-3.5 pb-2.5" data-slot="github-repos">
			<CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md py-1 text-left text-body text-muted-foreground hover:text-foreground">
				<ChevronRightIcon aria-hidden className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
				<span>Repositórios ({total})</span>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<ul className="mt-1 flex flex-col">
					{shown.map((repo) => (
						<li
							className="flex min-w-0 items-center gap-2 border-border/60 border-b py-1.5 last:border-b-0"
							key={repo.fullName}
						>
							<span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground" title={repo.fullName}>
								{repo.fullName}
							</span>
							{repo.private ? (
								<LockIcon aria-label="Privado" className="size-3.5 shrink-0 text-muted-foreground" />
							) : null}
						</li>
					))}
				</ul>
				{more > 0 ? (
					<Button className="mt-1.5 w-full" onClick={() => setVisible((n) => n + REPO_PAGE)} size="sm" type="button" variant="ghost">
						Carregar mais ({more})
					</Button>
				) : null}
				{inst.repoCount !== null && inst.repoCount > inst.repos.length && more === 0 ? (
					<p className="pt-1.5 text-caption text-muted-foreground">
						+{inst.repoCount - inst.repos.length} no GitHub
					</p>
				) : null}
			</CollapsibleContent>
		</Collapsible>
	);
}

function InstallationRows({
	inst,
	busy,
	onRefresh,
	onUnlink,
}: {
	inst: GithubAppInstallation;
	busy: string | null;
	onRefresh: (id: string) => void;
	onUnlink: (id: string) => void;
}) {
	const state = githubInstallationStatus(inst);
	const [confirm, setConfirm] = useState(false);
	return (
		<>
			<SettingRow
				caption={
					<p className="flex items-center gap-1.5">
						<span
							aria-hidden
							className={cn("size-1.5 rounded-full", state.tone === "ok" ? "bg-success" : "bg-warning")}
						/>
						<span>
							{githubRepoCountLabel(inst)} · {state.label}
						</span>
					</p>
				}
				control="inline"
				icon={GithubMarkIcon}
				label={githubAccountLabel(inst)}
				wrap
			>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button aria-label={`Opções de ${inst.accountLogin}`} disabled={busy !== null} size="icon-sm" type="button" variant="ghost" />
						}
					>
						{busy === inst.id ? <RefreshCwIcon aria-hidden className="animate-spin" /> : <EllipsisVerticalIcon aria-hidden />}
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-48">
						<DropdownMenuItem onClick={() => window.open(inst.manageUrl, "_blank", "noopener,noreferrer")}>
							<ExternalLinkIcon aria-hidden />
							Gerenciar no GitHub
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => onRefresh(inst.id)}>
							<RefreshCwIcon aria-hidden />
							Atualizar repositórios
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => setConfirm(true)} variant="destructive">
							<UnplugIcon aria-hidden />
							Desvincular
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</SettingRow>
			<RepoChips inst={inst} />
			<AlertDialog onOpenChange={setConfirm} open={confirm}>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>Desvincular {inst.accountLogin}?</AlertDialogTitle>
						<AlertDialogDescription>
							O agente deixa de receber eventos e de usar o app nesses repositórios. Para desinstalar de vez, use
							&quot;Gerenciar no GitHub&quot;.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancelar</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								setConfirm(false);
								onUnlink(inst.id);
							}}
						>
							Desvincular
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

/** Tudo no GitHub sai como o app (bot): aviso de permissões e assinatura opcional no rodapé. */
function WriteIdentityRows({ status, busy, onSave }: { status: GithubAppStatus; busy: string | null; onSave?: (patch: GithubWriteSettingsPatch) => void }) {
	const [text, setText] = useState(status.signatureText ?? "");
	const manage = status.installations[0]?.manageUrl ?? status.permissionsUrl;
	return (
		<div data-slot="github-write-as">
			<SettingRow caption={<p>{githubWriteAsCaption(status)}</p>} icon={GithubMarkIcon} label="Escritas no GitHub" />
			{status.missingWritePermissions.length > 0 ? (
				<div className="flex flex-col items-start gap-2 px-3.5 pb-3 text-body leading-[18px]" data-slot="github-permissions-warning" role="alert">
					<div className="flex items-start gap-2 text-destructive">
						<TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
						<p className="min-w-0 flex-1">{githubMissingPermissionsText(status.missingWritePermissions)}</p>
					</div>
					{manage ? <LinkButton external href={manage} variant="outline">Aceitar permissões no GitHub</LinkButton> : null}
				</div>
			) : null}
			<SettingRow caption={<p>Acrescenta uma linha discreta no fim do texto enviado. Desligado por padrão.</p>} control="inline" label="Assinar no rodapé">
				<Switch aria-label="Assinar no rodapé" checked={status.signature} disabled={busy !== null} onCheckedChange={(checked) => onSave?.({ signature: checked })} />
			</SettingRow>
			{status.signature ? (
				<div className="px-3.5 pb-3">
					<Input
						aria-label="Texto da assinatura"
						maxLength={120}
						onBlur={() => (text.trim() || null) !== status.signatureText && onSave?.({ signatureText: text.trim() || null })}
						onChange={(event) => setText(event.target.value)}
						placeholder="enviado pelo bot (nome do bot)"
						value={text}
					/>
				</div>
			) : null}
		</div>
	);
}

function OwnerAppRows({ status, busy, onRemoveApp }: { status: GithubAppStatus; busy: string | null; onRemoveApp: () => void }) {
	const [confirm, setConfirm] = useState(false);
	return (
		<>
			<SettingRow
				caption={
					<>
						<p className="truncate font-mono">{status.slug}</p>
						<p className="truncate font-mono">{status.webhookUrl}</p>
					</>
				}
				control="inline"
				description="Dono: o app é da instância inteira. Cada pessoa só precisa instalar."
				icon={GithubMarkIcon}
				label="App do GitHub"
				wrap
			>
				{status.appUrl || status.source === "db" ? (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={<Button aria-label="Opções do app do GitHub" disabled={busy !== null} size="icon-sm" type="button" variant="ghost" />}
						>
							<EllipsisVerticalIcon aria-hidden />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="min-w-44">
							{status.appUrl ? (
								<DropdownMenuItem onClick={() => window.open(status.appUrl ?? "", "_blank", "noopener,noreferrer")}>
									<ExternalLinkIcon aria-hidden />
									Abrir no GitHub
								</DropdownMenuItem>
							) : null}
							{status.source === "db" ? (
								<DropdownMenuItem onClick={() => setConfirm(true)} variant="destructive">
									<XIcon aria-hidden />
									Remover app
								</DropdownMenuItem>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
				) : null}
			</SettingRow>
			<AlertDialog onOpenChange={setConfirm} open={confirm}>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>Remover o app do GitHub?</AlertDialogTitle>
						<AlertDialogDescription>
							Aqui só some o registro guardado: as instalações deixam de funcionar até criar o app de novo. Apague o
							app também em github.com/settings/apps.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancelar</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								setConfirm(false);
								onRemoveApp();
							}}
						>
							Remover
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

/** Tela pura da seção "GitHub" (renderiza em teste estático). */
export function GithubAppSettingsView(props: GithubAppSettingsViewProps) {
	const { status, busy, error, notice } = props;
	const state = githubAppViewState(status);
	if (state === "loading" && !notice && !error) return null;
	return (
		<SettingsGroup title="GitHub">
			{notice ? <NoticeRow notice={notice} onDismiss={props.onDismissNotice} /> : null}
			{error ? <NoticeRow notice={{ tone: "error", text: error }} /> : null}
			{state === "owner-create" && status ? (
				<form action={GITHUB_APP_MANIFEST_START_PATH} data-slot="github-create-form" method="get">
					<SettingRow
						caption={<p>Faça isto uma única vez. Depois, cada pessoa só clica em instalar.</p>}
						description="Cria o app do GitHub da instância com as permissões e os eventos certos, sem copiar chave nenhuma."
						icon={GithubMarkIcon}
						label="Criar GitHub App"
					/>
					<div className="flex flex-wrap items-center gap-2 px-3.5 pb-3">
						<Input
							aria-label="Nome do app no GitHub"
							className="min-w-44 flex-1"
							defaultValue={status.defaultName}
							maxLength={34}
							name="name"
							required
						/>
						<Input
							aria-label="Organização (opcional)"
							className="w-full sm:w-44"
							maxLength={39}
							name="org"
							placeholder="Organização (opcional)"
						/>
						<Button className="w-full sm:w-auto" type="submit">
							Criar GitHub App
						</Button>
					</div>
				</form>
			) : null}
			{state === "waiting-owner" ? (
				<SettingRow
					caption={<p>O dono da instância ainda não criou o app do GitHub.</p>}
					control="inline"
					icon={GithubMarkIcon}
					label="Instalar no GitHub"
				/>
			) : null}
			{state === "install" ? (
				<SettingRow
					caption={<p>Escolha os repositórios e autorize. Sem token pessoal e sem webhook manual.</p>}
					control="inline"
					description="O agente lê e age só nos repositórios que você escolher, e os eventos chegam sozinhos."
					icon={GithubMarkIcon}
					label="GitHub"
					wrap
				>
					<LinkButton href={GITHUB_APP_INSTALL_PATH} variant="default">
						Instalar no GitHub
					</LinkButton>
				</SettingRow>
			) : null}
			{state === "installed" && status ? (
				<>
					{status.installations.map((inst) => (
						<InstallationRows busy={busy} inst={inst} key={inst.id} onRefresh={props.onRefresh} onUnlink={props.onUnlink} />
					))}
					<SettingRow control="inline" icon={PlusIcon} label="Outra conta ou organização">
						<LinkButton href={GITHUB_APP_INSTALL_PATH} variant="ghost">
							Instalar no GitHub
						</LinkButton>
					</SettingRow>
					<WriteIdentityRows busy={busy} onSave={props.onSaveWrite} status={status} />
				</>
			) : null}
			{status?.configured && status.isOwner ? (
				<OwnerAppRows busy={busy} onRemoveApp={props.onRemoveApp} status={status} />
			) : null}
		</SettingsGroup>
	);
}

/** Seção "GitHub" de Conexões: criar o app (dono), instalar e ver as instalações. */
export function GithubAppSettings() {
	const app = useGithubApp(true);
	return (
		<GithubAppSettingsView
			busy={app.busy}
			error={app.error}
			notice={app.notice}
			onDismissNotice={app.dismissNotice}
			onRefresh={(id) => void app.refresh(id)}
			onRemoveApp={() => void app.removeApp()}
			onSaveWrite={(patch) => void app.saveWriteSettings(patch)}
			onUnlink={(id) => void app.unlink(id)}
			status={app.status}
		/>
	);
}
