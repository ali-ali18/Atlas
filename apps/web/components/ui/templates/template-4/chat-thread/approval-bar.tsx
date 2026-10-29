"use client";

import { CheckIcon, ChevronDownIcon, EllipsisVerticalIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@workspace/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@workspace/ui/components/dropdown-menu";
import { approvalBarLabel, dockEntryPrefixes, type DockEntry } from "@/lib/approval-dock";
import { devApprovalOptions } from "@/lib/dev-approval-options";
import { useTranslations } from "@/lib/i18n/provider";

export type ApprovalBarProps = {
	/** Pedidos pendentes que já saíram da tela, do mais antigo ao mais recente (os visíveis ficam só no cartão da conversa). */
	entries: DockEntry[];
	onApprove: (entry: DockEntry) => void;
	onSkip: (entry: DockEntry) => void;
	/** "Sempre neste repositório": salva os prefixos do comando na lista do repositório e executa. Sem ela a barra não oferece o menu ⋮. */
	onAlways?: (entry: DockEntry) => void;
	/** Rola até o cartão na conversa e o destaca. */
	onLocate: (id: string) => void;
	/** Altura da barra (px), para a conversa deixar espaço embaixo. */
	onHeight?: (height: number) => void;
	/** Começa com a lista aberta (testes). */
	defaultExpanded?: boolean;
};

type RowProps = Pick<ApprovalBarProps, "onApprove" | "onSkip" | "onLocate" | "onAlways"> & { entry: DockEntry; extra?: ReactNode };

function Row({ entry, onApprove, onSkip, onLocate, onAlways, extra }: RowProps) {
	const { t } = useTranslations();
	const prefixes = dockEntryPrefixes(entry);
	const options = devApprovalOptions({ prefixes, canAlways: Boolean(onAlways) });
	return (
		<div className="flex min-h-11 min-w-0 items-center gap-1 pr-1 pl-3" data-approval-bar-row>
			<ShieldAlertIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
			<button
				className="min-w-0 flex-1 truncate rounded-md px-1.5 py-2 text-left text-foreground/90 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
				onClick={() => onLocate(entry.id)}
				type="button"
			>
				{approvalBarLabel(entry)}
			</button>
			{extra}
			{options.length > 1 ? (
				<DropdownMenu>
					<DropdownMenuTrigger render={<Button aria-label={t("chat.approvals.moreOptions")} className="size-9 shrink-0 rounded-full" data-approval-bar-more size="icon-sm" type="button" variant="ghost" />}>
						<EllipsisVerticalIcon />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-auto max-w-[20rem] min-w-44" side="top">
						{options.map((option) => (
							<DropdownMenuItem className="min-w-0" key={option.id} onClick={() => (option.id === "once" ? onApprove(entry) : option.id === "always" ? onAlways?.(entry) : onSkip(entry))} title={option.detail}>
								<span className="flex min-w-0 flex-col">
									<span className="truncate">{option.label}</span>
									{option.detail ? <span className="truncate text-muted-foreground text-xs">{option.detail}</span> : null}
								</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
			<Button aria-label={t("chat.approvals.run")} className="size-9 shrink-0 rounded-full" onClick={() => onApprove(entry)} size="icon-sm" type="button" variant="ghost">
				<CheckIcon />
			</Button>
			<Button aria-label={entry.type === "relayed" ? t("ui.cardDeny") : t("ui.cardDismiss")} className="size-9 shrink-0 rounded-full" onClick={() => onSkip(entry)} size="icon-sm" type="button" variant="ghost">
				<XIcon />
			</Button>
		</div>
	);
}

/**
 * Seção do container único do composer (acima do campo de texto, abaixo das tarefas), só com pedidos de aprovação que
 * a conversa já deixou para trás. Um pedido: uma linha (alerta + "Executar · comando", ✓ e ✗). Dois ou mais: o mais
 * recente na linha com o contador "+N"; tocar abre a lista inteira dentro da mesma seção.
 */
export function ApprovalBar({ entries: live, onApprove, onSkip, onLocate, onAlways, onHeight, defaultExpanded = false }: ApprovalBarProps) {
	const { t, tn } = useTranslations();
	const [expanded, setExpanded] = useState(defaultExpanded);
	const [shown, setShown] = useState(false);
	const [kept, setKept] = useState<DockEntry[]>(live);
	const rootRef = useRef<HTMLDivElement>(null);
	// Sai deslizando para trás do composer: guarda as últimas linhas até a transição acabar.
	const entries = live.length > 0 ? live : kept;
	const present = entries.length > 0;
	const liveKey = live.map((entry) => entry.id).join("|");
	const liveRef = useRef(live);
	liveRef.current = live;
	useEffect(() => {
		if (liveRef.current.length > 0) {
			setKept(liveRef.current);
			const frame = requestAnimationFrame(() => setShown(true));
			return () => cancelAnimationFrame(frame);
		}
		setShown(false);
		const timer = window.setTimeout(() => setKept([]), 220);
		return () => window.clearTimeout(timer);
	}, [liveKey]);

	// Volta a 1 item: recolhe sozinha.
	useEffect(() => {
		if (entries.length < 2) setExpanded(false);
	}, [entries.length]);

	// Toque fora recolhe.
	useEffect(() => {
		if (!expanded) return;
		const onPointerDown = (event: PointerEvent) => {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) setExpanded(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [expanded]);

	useEffect(() => {
		const element = rootRef.current;
		if (!present || !element || !onHeight || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => onHeight(element.offsetHeight));
		observer.observe(element);
		onHeight(element.offsetHeight);
		return () => {
			observer.disconnect();
			onHeight(0);
		};
	}, [onHeight, present]);

	if (!present) return null;
	const front = entries[entries.length - 1]!;
	const behind = entries.slice(0, -1);
	const stacked = behind.length > 0;
	const handlers = { onApprove, onSkip, onLocate, onAlways };
	const toggle = () => setExpanded((current) => !current);

	return (
		<div
			aria-label={t("chat.approvals.label")}
			className={`w-full min-w-0 border-b border-border/60 transition-opacity duration-200 motion-reduce:transition-none ${shown && live.length > 0 ? "opacity-100" : "opacity-0"}`}
			data-approval-bar
			data-expanded={expanded || undefined}
			data-stacked={stacked || undefined}
			ref={rootRef}
			role="region"
		>
			{stacked ? (
				<div
					className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
					data-approval-bar-list
					style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
				>
					<div className="min-h-0 overflow-hidden">
						<div className="flex items-center justify-between px-3 pt-2 text-muted-foreground text-xs">
							<span>{tn("chat.approvals.count", entries.length)}</span>
							<Button aria-label={t("chat.approvals.collapse")} className="size-7 rounded-full" onClick={toggle} size="icon-xs" type="button" variant="ghost">
								<ChevronDownIcon />
							</Button>
						</div>
						<div className="flex flex-col divide-y divide-foreground/10">
							{behind.map((entry) => (
								<Row entry={entry} key={entry.id} {...handlers} />
							))}
						</div>
					</div>
				</div>
			) : null}
			<div className={stacked && expanded ? "border-t border-foreground/10" : ""} data-approval-bar-front>
				<Row
					entry={front}
					extra={
						stacked && !expanded ? (
							<button
								aria-expanded={expanded}
								aria-label={tn("chat.approvals.more", behind.length)}
								className="shrink-0 rounded-full bg-foreground/10 px-2 py-1 text-foreground/80 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
								data-approval-stack-count
								onClick={toggle}
								type="button"
							>
								+{behind.length}
							</button>
						) : null
					}
					{...handlers}
				/>
			</div>
		</div>
	);
}
