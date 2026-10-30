"use client";

import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon, GlobeIcon, Trash2Icon } from "lucide-react";
import type { EmailDomainDto, EmailDomainRecordDto } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { cn } from "@workspace/ui/lib/utils";
import { useEmailDomains } from "@/hooks/use-email-domains";
import { useT, useTranslations } from "@/lib/i18n/provider";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";
import { SettingRow } from "../setting-row";

export function domainStatusLabel(domain: Pick<EmailDomainDto, "status" | "verified">, { t }: Translator = defaultTranslator): string {
	if (domain.verified) return t("settings.email.domainVerified");
	if (domain.status === "failed") return t("settings.email.domainFailed");
	if (domain.status === "under_review") return t("settings.email.domainReview");
	return t("settings.email.domainPending");
}

function CopyButton({ text, label }: { text: string; label: string }) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), 1600);
		return () => window.clearTimeout(timer);
	}, [copied]);
	return (
		<Button
			aria-label={copied ? t("settings.email.copied", { label }) : t("settings.email.copy", { label })}
			className="shrink-0 text-muted-foreground"
			onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined)}
			size="icon-xs"
			type="button"
			variant="ghost"
		>
			{copied ? <CheckIcon /> : <CopyIcon />}
		</Button>
	);
}

function RecordField({ field, text }: { field: "name" | "value"; text: string }) {
	const t = useT();
	const label = field === "name" ? t("settings.email.fieldName") : t("settings.email.fieldValue");
	return (
		<div className="flex h-8 min-w-0 items-center gap-2 border-border/60 border-t px-3">
			<span className="w-10 shrink-0 text-caption text-muted-foreground">{label}</span>
			<span className="min-w-0 flex-1 truncate font-mono text-caption" title={text}>
				{text}
			</span>
			<CopyButton label={field === "name" ? t("settings.email.fieldNameLower") : t("settings.email.fieldValueLower")} text={text} />
		</div>
	);
}

function RecordsTable({ records }: { records: EmailDomainRecordDto[] }) {
	const t = useT();
	return (
		<ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0" data-testid="dns-records">
			{records.map((record, index) => (
				<li
					className="min-w-0 overflow-hidden rounded-xl border border-border bg-card"
					data-dns-record={record.type}
					key={`${record.type}-${record.name}-${index}`}
				>
					<div className="flex h-8 min-w-0 items-center gap-2 px-3 text-caption">
						<span className="text-muted-foreground">{t("settings.email.recordType")}</span>
						<span className="font-medium">{record.type}</span>
						{record.priority !== null ? <span className="text-muted-foreground">{t("settings.email.recordPriority", { priority: record.priority })}</span> : null}
						<span className={cn("ml-auto flex items-center gap-1", record.valid ? "text-foreground" : "text-muted-foreground")}>
							{record.valid ? <CheckIcon aria-hidden className="size-3" /> : null}
							{record.valid ? t("settings.email.recordOk") : t("settings.email.recordMissing")}
						</span>
					</div>
					<RecordField field="name" text={record.name} />
					<RecordField field="value" text={record.value} />
				</li>
			))}
		</ul>
	);
}

function DomainCard({ domain, busy, onVerify, onRemove }: { domain: EmailDomainDto; busy: boolean; onVerify: () => void; onRemove: () => void }) {
	const translator = useTranslations();
	const { t } = translator;
	return (
		<div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/60 p-3" data-email-domain={domain.domain}>
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<p className="min-w-0 flex-1 basis-40 truncate font-medium text-body" title={domain.domain}>
					{domain.domain}
				</p>
				<span
					className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs", domain.verified ? "bg-muted text-foreground" : "border border-border text-muted-foreground")}
					data-testid="domain-status"
				>
					{domainStatusLabel(domain, translator)}
				</span>
				{domain.verified ? null : (
					<Button className="shrink-0" disabled={busy} onClick={onVerify} size="sm" type="button" variant="outline">
						{busy ? t("settings.email.verifying") : t("settings.email.verify")}
					</Button>
				)}
				<Button aria-label={t("settings.email.removeDomainAria", { domain: domain.domain })} className="shrink-0 text-muted-foreground" disabled={busy} onClick={onRemove} size="icon-sm" type="button" variant="ghost">
					<Trash2Icon />
				</Button>
			</div>
			{domain.verified ? (
				<p className="text-muted-foreground text-xs">{t("settings.email.domainReady")}</p>
			) : (
				<>
					<p className="text-muted-foreground text-xs leading-relaxed">{t("settings.email.domainDns")}</p>
					{domain.records.length > 0 ? <RecordsTable records={domain.records} /> : null}
				</>
			)}
		</div>
	);
}

/** Domínio próprio: adicionar, registros DNS com copiar, estado e verificar/remover. Só aparece com a chave do provedor. */
export function EmailDomainsPanel({
	domains,
	loading,
	error,
	busyId,
	onAdd,
	onVerify,
	onRemove,
}: {
	domains: EmailDomainDto[] | null;
	loading?: boolean;
	error?: string | null;
	busyId: string | null;
	onAdd: (domain: string) => Promise<boolean>;
	onVerify: (id: string) => void;
	onRemove: (id: string) => void;
}) {
	const t = useT();
	const [value, setValue] = useState("");
	const adding = busyId === "new";
	return (
		<>
			<SettingRow
				caption={
					<>
						<p className="text-muted-foreground text-xs">{t("settings.email.domainsNote")}</p>
						{error ? (
							<p className="text-destructive text-xs" role="alert">
								{error}
							</p>
						) : null}
					</>
				}
				control="inline"
				icon={GlobeIcon}
				label={t("settings.email.ownDomain")}
			/>
			<div className="flex min-w-0 flex-col gap-2 px-3.5 pb-2" data-testid="email-domains">
				<form
					className="flex min-w-0 items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (value.trim()) void onAdd(value.trim()).then((ok) => ok && setValue(""));
					}}
				>
					<Input
						aria-label={t("settings.email.addDomainAria")}
						autoComplete="off"
						className="min-w-0 flex-1"
						disabled={adding}
						onChange={(event) => setValue(event.target.value)}
						placeholder={t("settings.email.domainPlaceholder")}
						spellCheck={false}
						value={value}
					/>
					<Button disabled={adding || !value.trim()} size="sm" type="submit" variant="outline">
						{adding ? t("settings.email.adding") : t("settings.email.add")}
					</Button>
				</form>
				{loading && !domains ? <p className="text-muted-foreground text-xs">{t("common.loading")}</p> : null}
				{domains?.map((domain) => (
					<DomainCard busy={busyId === domain.id} domain={domain} key={domain.id} onRemove={() => onRemove(domain.id)} onVerify={() => onVerify(domain.id)} />
				))}
			</div>
		</>
	);
}

export function EmailDomainsConnected({ enabled }: { enabled: boolean }) {
	const state = useEmailDomains(enabled);
	if (!enabled) return null;
	return <EmailDomainsPanel busyId={state.busyId} domains={state.domains} error={state.error} loading={state.loading} onAdd={state.add} onRemove={(id) => void state.remove(id)} onVerify={(id) => void state.verify(id)} />;
}
