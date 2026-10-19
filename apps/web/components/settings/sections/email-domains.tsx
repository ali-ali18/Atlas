"use client";

import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon, GlobeIcon, Trash2Icon } from "lucide-react";
import type { EmailDomainDto, EmailDomainRecordDto } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { cn } from "@workspace/ui/lib/utils";
import { useEmailDomains } from "@/hooks/use-email-domains";
import { SettingRow } from "../setting-row";

export const EMAIL_DOMAINS_NOTE = "Use endereços como atendimento@suaempresa.com.br. Exige um plano pago do OpenMail.";

export function domainStatusLabel(domain: Pick<EmailDomainDto, "status" | "verified">): string {
	if (domain.verified) return "Verificado";
	if (domain.status === "failed") return "Falhou";
	if (domain.status === "under_review") return "Em análise";
	return "Pendente";
}

function CopyButton({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), 1600);
		return () => window.clearTimeout(timer);
	}, [copied]);
	return (
		<Button
			aria-label={copied ? `${label} copiado` : `Copiar ${label}`}
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

const CELL = "min-w-0 align-top py-2 pr-2 text-[11px] leading-4";

function RecordsTable({ records }: { records: EmailDomainRecordDto[] }) {
	return (
		<div className="min-w-0" data-testid="dns-records">
			<table className="w-full table-fixed border-collapse text-left">
				<thead>
					<tr className="text-[11px] text-muted-foreground">
						<th className="w-10 pb-1 pr-2 font-medium" scope="col">
							Tipo
						</th>
						<th className="pb-1 pr-2 font-medium" scope="col">
							Nome
						</th>
						<th className="pb-1 pr-2 font-medium" scope="col">
							Valor
						</th>
					</tr>
				</thead>
				<tbody>
					{records.map((record, index) => (
						<tr className="border-border/60 border-t" data-dns-record={record.type} key={`${record.type}-${record.name}-${index}`}>
							<td className={cn(CELL, "font-medium")}>
								<span className="flex items-center gap-1">
									{record.type}
									{record.valid ? <CheckIcon aria-label="Registro correto" className="size-3 text-muted-foreground" /> : null}
								</span>
							</td>
							<td className={CELL}>
								<span className="flex min-w-0 items-start gap-0.5">
									<span className="min-w-0 flex-1 break-all font-mono">{record.name}</span>
									<CopyButton label="nome" text={record.name} />
								</span>
							</td>
							<td className={CELL}>
								<span className="flex min-w-0 items-start gap-0.5">
									<span className="min-w-0 flex-1 break-all font-mono">
										{record.priority !== null ? `${record.priority} ` : ""}
										{record.value}
									</span>
									<CopyButton label="valor" text={record.value} />
								</span>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function DomainCard({ domain, busy, onVerify, onRemove }: { domain: EmailDomainDto; busy: boolean; onVerify: () => void; onRemove: () => void }) {
	return (
		<div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/60 p-3" data-email-domain={domain.domain}>
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<p className="min-w-0 flex-1 basis-40 truncate font-medium text-[13px]" title={domain.domain}>
					{domain.domain}
				</p>
				<span
					className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs", domain.verified ? "bg-muted text-foreground" : "border border-border text-muted-foreground")}
					data-testid="domain-status"
				>
					{domainStatusLabel(domain)}
				</span>
				{domain.verified ? null : (
					<Button className="shrink-0" disabled={busy} onClick={onVerify} size="sm" type="button" variant="outline">
						{busy ? "Verificando…" : "Verificar"}
					</Button>
				)}
				<Button aria-label={`Remover ${domain.domain}`} className="shrink-0 text-muted-foreground" disabled={busy} onClick={onRemove} size="icon-sm" type="button" variant="ghost">
					<Trash2Icon />
				</Button>
			</div>
			{domain.verified ? (
				<p className="text-muted-foreground text-xs">Pronto: já dá para criar endereços neste domínio na aba E-mail do bot.</p>
			) : (
				<>
					<p className="text-muted-foreground text-xs leading-relaxed">Publique estes registros no DNS do domínio e toque em Verificar. A checagem costuma levar alguns minutos.</p>
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
	const [value, setValue] = useState("");
	const adding = busyId === "new";
	return (
		<>
			<SettingRow
				caption={
					<>
						<p className="text-muted-foreground text-xs">{EMAIL_DOMAINS_NOTE}</p>
						{error ? (
							<p className="text-destructive text-xs" role="alert">
								{error}
							</p>
						) : null}
					</>
				}
				control="inline"
				icon={GlobeIcon}
				label="Domínio próprio"
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
						aria-label="Adicionar domínio"
						autoComplete="off"
						className="min-w-0 flex-1"
						disabled={adding}
						onChange={(event) => setValue(event.target.value)}
						placeholder="suaempresa.com.br"
						spellCheck={false}
						value={value}
					/>
					<Button disabled={adding || !value.trim()} size="sm" type="submit" variant="outline">
						{adding ? "Adicionando…" : "Adicionar"}
					</Button>
				</form>
				{loading && !domains ? <p className="text-muted-foreground text-xs">Carregando…</p> : null}
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
