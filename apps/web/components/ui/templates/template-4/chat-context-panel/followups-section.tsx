"use client";

import { CalendarClockIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { cn } from "@workspace/ui/lib/utils";
import { formatFollowupDue, quickRescheduleOptions, toLocalInputValue } from "@workspace/shared";
import { SettingRow, SettingsGroup, SettingsStack } from "@/components/settings/setting-row";
import type { BotFollowup } from "@/lib/atlas-api";

/** "Lembrete" ou "Verificação". */
export function followupKindLabel(kind: BotFollowup["kind"]): string {
	return kind === "check" ? "Verificação" : "Lembrete";
}

/** "Lembrete" ou "Verificação" + de onde veio (você pediu / o bot decidiu). */
export function followupSubtitle(item: Pick<BotFollowup, "kind" | "source"> & Partial<Pick<BotFollowup, "stages">>, due: string): string {
	const stages = item.stages ?? [];
	if (stages.length > 1) {
		const position = Math.min(stages.length, stages.filter((stage) => stage.firedAt).length + 1);
		return `Próximo aviso: ${due} · ${position} de ${stages.length}${item.source === "reflection" ? " · ideia do bot" : ""}`;
	}
	return `${due} · ${followupKindLabel(item.kind)}${item.source === "reflection" ? " · ideia do bot" : ""}`;
}

type Stage = NonNullable<BotFollowup["stages"]>[number];

/** Avisos do lembrete; sem a lista (lembrete antigo), um aviso só em `dueAt`. */
function stagesOf(item: BotFollowup): Stage[] {
	return item.stages && item.stages.length > 0 ? item.stages : [{ at: item.dueAt, firedAt: null }];
}

export type RescheduleOutcome = { ok: true; movedForQuietHours: boolean } | { ok: false; error: string };

/**
 * Seletor de novo horário: atalhos (amanhã, em 3 dias, próxima segunda) que preenchem o campo de
 * data e hora, que o usuário ainda pode ajustar. O horário é lido no fuso da conta.
 */
export function ReschedulePicker({
	timeZone,
	now,
	initialValue,
	busy,
	error,
	onSave,
	onBack,
	title = "Novo horário",
}: {
	timeZone: string;
	now: Date;
	/** Título (ex.: "Aviso 2 de 4"). */
	title?: string;
	initialValue?: string;
	busy: boolean;
	error: string | null;
	onSave: (localValue: string) => void;
	onBack: () => void;
}) {
	const options = quickRescheduleOptions(now, timeZone);
	const min = toLocalInputValue(now, timeZone);
	const [value, setValue] = useState(initialValue ?? "");
	const valid = value !== "" && value > min;

	return (
		<div className="flex flex-col gap-3 rounded-card border border-border/60 px-3.5 py-3" data-reschedule-picker>
			<p className="text-body leading-[18px]">{title}</p>
			<div className="flex flex-wrap gap-2">
				{options.map((option) => (
					<button
						aria-pressed={value === option.local}
						className={cn(
							"h-8 rounded-full border px-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
							value === option.local
								? "border-foreground/30 bg-accent text-foreground"
								: "border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground",
						)}
						data-quick={option.id}
						key={option.id}
						onClick={() => setValue(option.local)}
						type="button"
					>
						{option.label}
					</button>
				))}
			</div>
			<Input
				aria-label="Data e hora do lembrete"
				className="[color-scheme:light] dark:[color-scheme:dark]"
				min={min}
				onChange={(event) => setValue(event.target.value)}
				type="datetime-local"
				value={value}
			/>
			{error ? (
				<p className="text-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
			<div className="grid grid-cols-2 gap-2">
				<Button disabled={busy} onClick={onBack} type="button" variant="ghost">
					Voltar
				</Button>
				<Button disabled={busy || !valid} onClick={() => onSave(value)} type="button">
					Salvar
				</Button>
			</div>
		</div>
	);
}

/**
 * Detalhe de um lembrete (subvista do painel): texto completo, quando dispara, tipo, origem,
 * Reagendar (abre o seletor no próprio detalhe) e o botão de cancelar, que volta para a lista.
 */
export function FollowupDetail({
	item,
	timeZone,
	onCancel,
	onDone,
	onReschedule,
	now,
}: {
	item: BotFollowup;
	timeZone: string;
	onCancel: (followupId: string) => Promise<boolean>;
	onDone: () => void;
	onReschedule?: (followupId: string, when: string, stage?: number) => Promise<RescheduleOutcome>;
	/** Relógio (testes); padrão: agora. */
	now?: Date;
}) {
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	/** Aviso (1 = primeiro) que o seletor vai mover; null = fechado; 0 = o próximo pendente. */
	const [picking, setPicking] = useState<number | null>(null);
	const [pickError, setPickError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	async function cancel() {
		setBusy(true);
		setFailed(false);
		const ok = await onCancel(item.id);
		setBusy(false);
		if (ok) onDone();
		else setFailed(true);
	}

	async function save(localValue: string) {
		if (!onReschedule) return;
		setBusy(true);
		setPickError(null);
		const result = await onReschedule(item.id, localValue, picking && picking > 0 ? picking : undefined);
		setBusy(false);
		if (!result.ok) {
			setPickError(result.error);
			return;
		}
		setPicking(null);
		setNotice(result.movedForQuietHours ? "Reagendado. Caiu no horário de silêncio, então foi para o fim dele." : "Lembrete reagendado.");
	}

	const stages = stagesOf(item);
	const multi = stages.length > 1;
	const nextIndex = stages.findIndex((stage) => !stage.firedAt);
	const pickTitle = !multi
		? "Novo horário"
		: `Aviso ${(picking && picking > 0 ? picking : nextIndex + 1) || 1} de ${stages.length}`;

	return (
		<div
			className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-2 pb-[calc(2rem+env(safe-area-inset-bottom))]"
			data-followup-detail={item.id}
		>
			<SettingsStack>
				<div className="rounded-card border border-border/60 px-3.5 py-3 text-body leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
					{item.note}
				</div>
				{multi ? (
					<SettingsGroup title="Avisos">
						{stages.map((stage, index) => {
							const isNext = index === nextIndex;
							return (
								<SettingRow key={stage.at + index} label={`${index + 1}º aviso`}>
									<span className="flex items-center gap-2" data-stage={isNext ? "next" : stage.firedAt ? "done" : "pending"}>
										<span className="flex flex-col items-end">
											<span className={cn("text-body whitespace-nowrap", isNext ? "font-medium text-foreground" : "text-muted-foreground", stage.firedAt && "line-through")}>
												{formatFollowupDue(new Date(stage.at), timeZone)}
											</span>
											{isNext ? <span className="text-caption text-foreground">Próximo</span> : null}
											{stage.firedAt ? <span className="text-caption text-muted-foreground">Enviado</span> : null}
										</span>
										{!stage.firedAt && onReschedule ? (
											<Button
												aria-label={`Reagendar ${index + 1}º aviso`}
												className="text-muted-foreground"
												disabled={busy}
												onClick={() => {
													setNotice(null);
													setPickError(null);
													setPicking(index + 1);
												}}
												size="icon-sm"
												type="button"
												variant="ghost"
											>
												<CalendarClockIcon aria-hidden />
											</Button>
										) : onReschedule ? (
											<span aria-hidden className="size-7 shrink-0" />
										) : null}
									</span>
								</SettingRow>
							);
						})}
					</SettingsGroup>
				) : null}
				<SettingsGroup>
					{multi ? null : (
						<SettingRow label="Dispara">
							<span className="text-body text-muted-foreground">{formatFollowupDue(new Date(item.dueAt), timeZone)}</span>
						</SettingRow>
					)}
					<SettingRow label="Tipo">
						<span className="text-body text-muted-foreground">{followupKindLabel(item.kind)}</span>
					</SettingRow>
					<SettingRow label="Origem">
						<span className="text-body text-muted-foreground">{item.source === "reflection" ? "Ideia do bot" : "Você pediu"}</span>
					</SettingRow>
				</SettingsGroup>
				{notice ? (
					<p className="px-1 text-center text-muted-foreground text-xs" role="status">
						{notice}
					</p>
				) : null}
				<div className="flex flex-col gap-2">
					{onReschedule && picking !== null ? (
						<ReschedulePicker
							busy={busy}
							error={pickError}
							now={now ?? new Date()}
							onBack={() => {
								setPicking(null);
								setPickError(null);
							}}
							onSave={(value) => void save(value)}
							timeZone={timeZone}
							title={pickTitle}
						/>
					) : onReschedule ? (
						<Button
							className="w-full"
							disabled={busy}
							onClick={() => {
								setNotice(null);
								setPicking(0);
							}}
							type="button"
							variant="secondary"
						>
							<CalendarClockIcon aria-hidden data-icon="inline-start" />
							{multi ? "Reagendar próximo aviso" : "Reagendar"}
						</Button>
					) : null}
					<Button
						className="w-full border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
						disabled={busy}
						onClick={() => void cancel()}
						type="button"
						variant="outline"
					>
						Cancelar lembrete
					</Button>
					{failed ? (
						<p className="text-center text-destructive text-xs" role="alert">
							Não foi possível cancelar. Tente de novo.
						</p>
					) : null}
				</div>
			</SettingsStack>
		</div>
	);
}

/**
 * Lembretes agendados pelo bot principal (seção Rotinas da Biblioteca do painel). Cada item
 * mostra o texto e quando vai disparar, com o mesmo cartão das rotinas; tocar abre o detalhe
 * no painel e o X cancela.
 */
export function FollowupsSection({
	followups,
	loaded,
	timeZone,
	onCancel,
	onOpen,
}: {
	followups: readonly BotFollowup[];
	loaded: boolean;
	timeZone: string;
	onCancel: (followupId: string) => Promise<boolean>;
	/** Abre o detalhe do lembrete no painel. */
	onOpen?: (followupId: string) => void;
}) {
	const [busy, setBusy] = useState<string | null>(null);
	const [failed, setFailed] = useState<string | null>(null);

	async function cancel(id: string) {
		setBusy(id);
		setFailed(null);
		const ok = await onCancel(id);
		setBusy(null);
		if (!ok) setFailed(id);
	}

	return (
		<section aria-labelledby="info-pane-followups" className="space-y-2">
			<h3 className="font-medium text-muted-foreground text-xs" id="info-pane-followups">
				Lembretes agendados
			</h3>
			{followups.length === 0 ? (
				<p className="text-muted-foreground text-xs">{loaded ? "Nenhum lembrete agendado" : "Carregando…"}</p>
			) : (
				<ul className="flex flex-col gap-2">
					{followups.map((item) => (
						<li key={item.id}>
							<div
								className="group/followup flex min-w-0 items-center gap-2 rounded-2xl border border-border bg-card px-3 py-2.5"
								data-followup={item.id}
							>
								<button
									aria-label={`Abrir lembrete: ${item.note}`}
									className="flex min-w-0 flex-1 items-center gap-1 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
									onClick={() => onOpen?.(item.id)}
									type="button"
								>
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]" title={item.note}>
											{item.note}
										</span>
										<span className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
											{followupSubtitle(item, formatFollowupDue(new Date(item.dueAt), timeZone))}
										</span>
									</span>
								</button>
								<Button
									aria-label={`Cancelar lembrete: ${item.note}`}
									className="shrink-0 text-muted-foreground"
									disabled={busy === item.id}
									onClick={() => void cancel(item.id)}
									size="icon-sm"
									type="button"
									variant="ghost"
								>
									<XIcon />
								</Button>
							</div>
							{failed === item.id ? (
								<p className="px-3 pt-1 text-destructive text-xs" role="alert">
									Não foi possível cancelar. Tente de novo.
								</p>
							) : null}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
