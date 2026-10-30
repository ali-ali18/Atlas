"use client";

import { ArrowDownLeftIcon, ArrowUpRightIcon, ArrowRightIcon, CheckIcon, ChevronDownIcon, CopyIcon, MailIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { BotMailboxDto, EmailMessageDto } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { Input } from "@workspace/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Switch } from "@workspace/ui/components/switch";
import { cn } from "@workspace/ui/lib/utils";
import { openSettingsModal } from "@/components/settings/settings-url";
import { useBotEmail } from "@/hooks/use-bot-email";
import { useEmailDomains } from "@/hooks/use-email-domains";
import { openSendersPage } from "@/lib/email-senders-url";
import {
	addAllowedSender,
	emailOpensConversation,
	emailPeer,
	emailStatusBadge,
	emailSubject,
	moreSendersLabel,
	parseDailyLimit,
	previewAllowedSenders,
} from "./bot-email-helpers";
import { useT, useTranslations } from "@/lib/i18n/provider";
import { memoryRelativeDate } from "./memory-tab-helpers";

const SECTION_TITLE = "font-medium text-muted-foreground text-xs";

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
	return (
		<section aria-labelledby={id} className="flex min-w-0 flex-col gap-2" data-email-section={id}>
			<h3 className={SECTION_TITLE} id={id}>
				{title}
			</h3>
			{children}
		</section>
	);
}

export const DEFAULT_DOMAIN_VALUE = "__default";

/** Domínio da caixa nova: o do provedor (padrão) ou um domínio próprio já verificado. */
export function DomainChoice({ domains, value, onChange, disabled }: { domains: string[]; value: string; onChange: (value: string) => void; disabled?: boolean }) {
	const t = useT();
	return (
		<div className="flex w-full min-w-0 flex-col gap-1.5 text-left" data-testid="email-domain-choice">
			<label className="font-medium text-xs" htmlFor="email-domain-select">
				{t("botSettings.email.domainLabel")}
			</label>
			<Select disabled={disabled} onValueChange={(next) => onChange(next as string)} value={value}>
				<SelectTrigger className="w-full" id="email-domain-select">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={DEFAULT_DOMAIN_VALUE}>{t("botSettings.email.domainDefault")}</SelectItem>
					{domains.map((domain) => (
						<SelectItem key={domain} value={domain}>
							{domain}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

function AddressCard({ mailbox, busy, onToggle }: { mailbox: BotMailboxDto; busy: boolean; onToggle: (enabled: boolean) => void }) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), 1600);
		return () => window.clearTimeout(timer);
	}, [copied]);
	const copyLabel = copied ? t("botSettings.email.copied") : t("botSettings.email.copy");
	return (
		<div className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-3" data-testid="email-address-card">
			<div className="flex min-w-0 items-center gap-2">
				<span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
					<MailIcon className="size-4" />
				</span>
				<p className="min-w-0 flex-1 truncate font-medium text-sm leading-snug" data-testid="email-address" title={mailbox.address}>
					{mailbox.address}
				</p>
				<Button
					aria-label={copyLabel}
					className="shrink-0 text-muted-foreground"
					onClick={() => {
						void navigator.clipboard?.writeText(mailbox.address).then(() => setCopied(true), () => undefined);
					}}
					size="icon-sm"
					variant="ghost"
				>
					{copied ? <CheckIcon /> : <CopyIcon />}
				</Button>
			</div>
			<div className="-mx-3 flex items-center justify-between gap-3 border-border border-t px-3 pt-3">
				<div className="min-w-0">
					<p className="font-medium text-sm" id="email-enabled-label">
						{t("botSettings.email.receiving")}
					</p>
					<p className="text-muted-foreground text-xs">{mailbox.enabled ? t("botSettings.email.receivingOn") : t("botSettings.email.receivingOff")}</p>
				</div>
				<Switch aria-labelledby="email-enabled-label" checked={mailbox.enabled} disabled={busy} onCheckedChange={onToggle} />
			</div>
		</div>
	);
}

const SENDER_ROW = "flex h-10 min-w-0 items-center gap-2 rounded-2xl border border-border bg-card pr-1 pl-3";

function SenderRow({ rule, busy, onRemove }: { rule: string; busy: boolean; onRemove: () => void }) {
	const t = useT();
	return (
		<li className={SENDER_ROW} data-allowed-sender={rule}>
			<span className="min-w-0 flex-1 truncate text-sm">{rule}</span>
			<Button aria-label={t("botSettings.email.removeSender", { rule })} className="shrink-0 text-muted-foreground" disabled={busy} onClick={onRemove} size="icon-sm" variant="ghost">
				<XIcon />
			</Button>
		</li>
	);
}

/** Lista curta da aba: o primeiro remetente e, recolhidos, os mais recentes (a lista completa fica numa página). */
export function SenderPreviewList({ senders, busy, onChange, onOpenAll, defaultOpen = false }: { senders: string[]; busy: boolean; onChange: (next: string[]) => Promise<boolean>; onOpenAll: () => void; defaultOpen?: boolean }) {
	const translator = useTranslations();
	const { t } = translator;
	const [open, setOpen] = useState(defaultOpen);
	const { first, recent, more } = previewAllowedSenders(senders);
	if (first === null) return null;
	const remove = (rule: string) => void onChange(senders.filter((item) => item !== rule));
	return (
		<div className="flex min-w-0 flex-col gap-1.5" data-testid="allowed-preview">
			<ul aria-label={t("botSettings.email.allowed")} className="m-0 flex list-none flex-col gap-1.5 p-0">
				<SenderRow busy={busy} onRemove={() => remove(first)} rule={first} />
			</ul>
			{more > 0 ? (
				<Collapsible onOpenChange={setOpen} open={open}>
					<CollapsibleTrigger
						className={cn(SENDER_ROW, "w-full cursor-pointer pr-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50")}
						data-testid="allowed-more"
					>
						<span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">{moreSendersLabel(more, translator)}</span>
						<ChevronDownIcon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div className="flex min-w-0 flex-col gap-1.5 pt-1.5">
							<ul aria-label={t("botSettings.email.recent")} className="m-0 flex list-none flex-col gap-1.5 p-0">
								{recent.map((rule) => (
									<SenderRow busy={busy} key={rule} onRemove={() => remove(rule)} rule={rule} />
								))}
							</ul>
							<button
								className={cn(SENDER_ROW, "w-full cursor-pointer border-dashed bg-transparent pr-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50")}
								data-testid="allowed-view-all"
								onClick={onOpenAll}
								type="button"
							>
								<span className="min-w-0 flex-1 truncate font-medium text-sm">{t("botSettings.email.viewAll")}</span>
								<ArrowRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
							</button>
						</div>
					</CollapsibleContent>
				</Collapsible>
			) : null}
		</div>
	);
}

function AllowedSenders({ mailbox, busy, onChange, onOpenAll }: { mailbox: BotMailboxDto; busy: boolean; onChange: (next: string[]) => Promise<boolean>; onOpenAll: () => void }) {
	const translator = useTranslations();
	const { t } = translator;
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	async function add() {
		const result = addAllowedSender(mailbox.allowedSenders, value, translator);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		setError(null);
		if (await onChange(result.next)) setValue("");
	}
	return (
		<Section id="email-allowed" title={t("botSettings.email.allowed")}>
			<p className="text-muted-foreground text-xs leading-relaxed">{t("botSettings.email.allowedHelp")}</p>
			{mailbox.allowedSenders.length === 0 ? (
				<p className="rounded-2xl border border-border border-dashed px-3 py-3 text-muted-foreground text-xs leading-relaxed">{t("botSettings.email.emptyAllowed")}</p>
			) : (
				<SenderPreviewList busy={busy} onChange={onChange} onOpenAll={onOpenAll} senders={mailbox.allowedSenders} />
			)}
			<form
				className="flex min-w-0 items-center gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					void add();
				}}
			>
				<Input
					aria-invalid={error ? true : undefined}
					aria-label={t("botSettings.email.addSender")}
					autoComplete="off"
					className="min-w-0 flex-1"
					disabled={busy}
					inputMode="email"
					onChange={(event) => {
						setValue(event.target.value);
						setError(null);
					}}
					placeholder={t("botSettings.email.addSenderPlaceholder")}
					spellCheck={false}
					value={value}
				/>
				<Button disabled={busy || !value.trim()} size="sm" type="submit" variant="outline">
					{t("botSettings.email.add")}
				</Button>
			</form>
			{error ? (
				<p className="text-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
		</Section>
	);
}

function DailyLimit({ mailbox, busy, onChange }: { mailbox: BotMailboxDto; busy: boolean; onChange: (limit: number) => Promise<boolean> }) {
	const t = useT();
	const [value, setValue] = useState(String(mailbox.dailySendLimit));
	const [error, setError] = useState<string | null>(null);
	useEffect(() => setValue(String(mailbox.dailySendLimit)), [mailbox.dailySendLimit]);
	async function commit() {
		const limit = parseDailyLimit(value);
		if (limit === null) {
			setError(t("botSettings.email.limitError"));
			return;
		}
		setError(null);
		if (limit !== mailbox.dailySendLimit) await onChange(limit);
	}
	return (
		<Section id="email-limit" title={t("botSettings.email.limitTitle")}>
			<div className="flex min-w-0 items-center justify-between gap-3 rounded-2xl border border-border bg-card p-3">
				<div className="min-w-0">
					<label className="font-medium text-sm" htmlFor="email-daily-limit">
						{t("botSettings.email.perDay")}
					</label>
					<p className="text-muted-foreground text-xs" data-testid="email-sent-today">
						{t("botSettings.email.sentToday", { sent: mailbox.sentToday, limit: mailbox.dailySendLimit })}
					</p>
				</div>
				<Input
					aria-invalid={error ? true : undefined}
					className="w-20 shrink-0 text-center"
					disabled={busy}
					id="email-daily-limit"
					inputMode="numeric"
					onBlur={() => void commit()}
					onChange={(event) => {
						setValue(event.target.value);
						setError(null);
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
					}}
					value={value}
				/>
			</div>
			{error ? (
				<p className="text-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
		</Section>
	);
}

function MessageRowItem({ message, now, onOpen }: { message: EmailMessageDto; now: Date; onOpen?: () => void }) {
	const translator = useTranslations();
	const { t, locale } = translator;
	const badge = emailStatusBadge(message, translator);
	const inbound = message.direction === "in";
	const Icon = inbound ? ArrowDownLeftIcon : ArrowUpRightIcon;
	const body = (
		<>
			<span
				aria-hidden="true"
				className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground", badge?.tone === "danger" && "bg-destructive/10 text-destructive")}
			>
				<Icon className="size-3.5" />
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
				<span className="flex min-w-0 items-baseline gap-2">
					<span className="min-w-0 flex-1 truncate font-medium text-sm">{emailSubject(message, translator)}</span>
					<span className="shrink-0 text-muted-foreground text-xs">{memoryRelativeDate(message.createdAt, now, undefined, locale)}</span>
				</span>
				<span className="truncate text-muted-foreground text-xs">{emailPeer(message, translator)}</span>
				{badge ? (
					<span className="mt-0.5 w-fit rounded-full bg-destructive/10 px-2 py-0.5 text-destructive text-xs">{badge.label}</span>
				) : null}
			</span>
		</>
	);
	const itemClass = "flex w-full min-w-0 items-start gap-2.5 rounded-2xl border border-border bg-card px-3 py-2.5";
	return (
		<li className="min-w-0" data-email-message={message.id} data-direction={message.direction}>
			{onOpen ? (
				<button aria-label={t("botSettings.email.openConversation", { subject: emailSubject(message, translator) })} className={cn(itemClass, "cursor-pointer outline-none transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50")} onClick={onOpen} type="button">
					{body}
				</button>
			) : (
				<div className={itemClass}>{body}</div>
			)}
		</li>
	);
}

function Messages({ messages, onOpenConversation }: { messages: EmailMessageDto[]; onOpenConversation?: () => void }) {
	const t = useT();
	const now = new Date();
	return (
		<Section id="email-messages" title={t("botSettings.email.messages")}>
			{messages.length === 0 ? (
				<p className="text-muted-foreground text-xs leading-relaxed">{t("botSettings.email.noMessages")}</p>
			) : (
				<ul aria-label={t("botSettings.email.messages")} className="m-0 flex list-none flex-col gap-1.5 p-0">
					{messages.map((message) => (
						<MessageRowItem key={message.id} message={message} now={now} onOpen={emailOpensConversation(message) ? onOpenConversation : undefined} />
					))}
				</ul>
			)}
		</Section>
	);
}

function RemoveAddress({ busy, onRemove }: { busy: boolean; onRemove: () => Promise<boolean> }) {
	const t = useT();
	const [confirming, setConfirming] = useState(false);
	return (
		<Section id="email-remove" title={t("botSettings.email.address")}>
			{confirming ? (
				<div className="flex flex-col gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-3" role="alertdialog">
					<p className="text-sm leading-relaxed">{t("botSettings.email.removeConfirm")}</p>
					<div className="flex justify-end gap-2">
						<Button disabled={busy} onClick={() => setConfirming(false)} size="sm" variant="ghost">
							{t("common.cancel")}
						</Button>
						<Button disabled={busy} onClick={() => void onRemove().then((ok) => ok && setConfirming(false))} size="sm" variant="destructive">
							{busy ? t("botSettings.email.removing") : t("botSettings.email.removeAddress")}
						</Button>
					</div>
				</div>
			) : (
				<Button className="w-fit" onClick={() => setConfirming(true)} size="sm" variant="outline">
					{t("botSettings.email.removeAddress")}
				</Button>
			)}
		</Section>
	);
}

/**
 * Aba E-mail do bot: ativar o endereço (provedor hospedado), remetentes permitidos, limite diário e as
 * últimas mensagens. Tocar numa mensagem recebida abre a conversa do bot (o e-mail entra nela).
 */
export function BotEmailTab({ botId, active, onOpenConversation }: { botId: string; active: boolean; onOpenConversation?: () => void }) {
	const t = useT();
	const email = useBotEmail(botId, active);
	// Domínios próprios verificados: só carregam quando falta o endereço e a chave existe (falha = só o padrão).
	const offState = email.data !== null && !email.data.mailbox && email.data.account.configured;
	const customDomains = useEmailDomains(offState);
	const [domainChoice, setDomainChoice] = useState(DEFAULT_DOMAIN_VALUE);
	const verifiedDomains = (customDomains.domains ?? []).filter((item) => item.verified).map((item) => item.domain);

	if (email.loading && !email.data) {
		return (
			<div aria-busy="true" aria-label={t("botSettings.email.loading")} className="flex flex-col gap-3" role="status">
				<Skeleton className="h-20 w-full" />
				<Skeleton className="h-5 w-32" />
				<Skeleton className="h-16 w-full" />
			</div>
		);
	}
	if (email.loadError && !email.data) {
		return (
			<div className="flex flex-col items-center gap-3 py-8 text-center" role="alert">
				<p className="text-muted-foreground text-xs leading-relaxed">{email.loadError}</p>
				<Button onClick={() => void email.refresh()} size="sm" variant="outline">
					{t("common.retry")}
				</Button>
			</div>
		);
	}
	const data = email.data;
	if (!data) return null;

	if (!data.mailbox) {
		return (
			<div className="flex flex-col gap-4" data-email-state="off">
				<div className="flex flex-col items-center gap-3 rounded-2xl border border-border border-dashed px-4 py-8 text-center">
					<span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
						<MailIcon className="size-5" />
					</span>
					<div className="flex flex-col gap-1">
						<p className="font-medium text-sm">{t("botSettings.email.offTitle")}</p>
						<p className="text-muted-foreground text-xs leading-relaxed">{t("botSettings.email.offBody")}</p>
					</div>
					{data.account.configured ? (
						<div className="flex w-full min-w-0 flex-col items-center gap-3">
							{verifiedDomains.length > 0 ? <DomainChoice disabled={email.busy} domains={verifiedDomains} onChange={setDomainChoice} value={verifiedDomains.includes(domainChoice) ? domainChoice : DEFAULT_DOMAIN_VALUE} /> : null}
							<Button disabled={email.busy} onClick={() => void email.enable(verifiedDomains.includes(domainChoice) ? domainChoice : undefined)} size="sm">
								{email.busy ? t("botSettings.email.enabling") : t("botSettings.email.enable")}
							</Button>
						</div>
					) : (
						<div className="flex flex-col items-center gap-2">
							<p className="text-muted-foreground text-xs leading-relaxed" data-testid="email-no-key">
								{t("botSettings.email.noKey")}
							</p>
							<Button onClick={() => openSettingsModal("provedores")} size="sm" variant="outline">
								{t("botSettings.email.openSettings")}
							</Button>
						</div>
					)}
				</div>
				{email.actionError ? (
					<p className="text-destructive text-xs leading-relaxed" role="alert">
						{email.actionError}
					</p>
				) : null}
			</div>
		);
	}

	const mailbox = data.mailbox;
	return (
		<div className="flex min-w-0 flex-col gap-5" data-email-state="on">
			<AddressCard busy={email.busy} mailbox={mailbox} onToggle={(enabled) => void email.patch({ enabled })} />
			<AllowedSenders busy={email.busy} mailbox={mailbox} onChange={(allowedSenders) => email.patch({ allowedSenders })} onOpenAll={() => openSendersPage(botId)} />
			<DailyLimit busy={email.busy} mailbox={mailbox} onChange={(dailySendLimit) => email.patch({ dailySendLimit })} />
			<Messages messages={data.messages} onOpenConversation={onOpenConversation} />
			<RemoveAddress busy={email.busy} onRemove={() => email.remove()} />
			{email.actionError ? (
				<p className="text-destructive text-xs leading-relaxed" role="alert">
					{email.actionError}
				</p>
			) : null}
		</div>
	);
}
