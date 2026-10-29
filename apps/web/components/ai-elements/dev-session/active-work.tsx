"use client";

import { ChevronDownIcon, ChevronRightIcon, ListTodoIcon, SquareTerminalIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import { Sheet, SheetContent, SheetTitle } from "@workspace/ui/components/sheet";
import { cn } from "@workspace/ui/lib/utils";

import type { ActiveWorkItemResponse } from "@/lib/atlas-api";
import { markActiveWorkSeen, useActiveWork, type ActiveWorkRow } from "@/lib/dev-session/active-work";
import { formatElapsed } from "@/lib/dev-session/reducer";
import { useNow } from "@/lib/dev-session/store";

const STATE_LABEL: Record<ActiveWorkRow["state"], string> = {
	working: "Trabalhando",
	waiting: "Aguardando aprovação",
	done: "Concluída",
	error: "Erro",
};

const DOT: Record<ActiveWorkRow["state"], string> = {
	working: "bg-success animate-pulse",
	waiting: "bg-warning",
	done: "bg-muted-foreground/60",
	error: "bg-destructive",
};

/** Linha neutra: ícone, título, "conversa · tempo" e o selo de aprovação ou o ponto de não visto. */
export function ActiveWorkRowView({ row, now, onOpen }: { row: ActiveWorkRow; now: number; onOpen: (item: ActiveWorkItemResponse) => void }) {
	const Icon = row.item.kind === "dev" ? SquareTerminalIcon : UsersIcon;
	const running = row.state === "working" || row.state === "waiting";
	const time = running ? formatElapsed(Math.max(0, now - row.startedAt)) : STATE_LABEL[row.state];
	return (
		<button
			aria-label={`Abrir ${row.title} na conversa ${row.conversation}`}
			className="group/work flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50"
			data-active-work-row
			onClick={() => onOpen(row.item)}
			type="button"
		>
			<span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground [&_svg:not([class*='size-'])]:size-3.5">
				<Icon />
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate font-medium text-sm">{row.title}</span>
				<span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
					<span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT[row.state])} />
					<span className="min-w-0 truncate">{row.conversation}</span>
					<span aria-hidden="true">·</span>
					<span className="shrink-0 tabular-nums">{time}</span>
				</span>
				{row.awaitingApproval ? (
					<span className="mt-1 inline-block rounded-full bg-muted px-2 py-0.5 font-medium text-caption text-foreground/80" data-awaiting-approval>
						Aguardando aprovação
					</span>
				) : null}
			</span>
			{row.unread && !row.awaitingApproval ? (
				<span aria-label="Terminou desde a última visita" className="size-2 shrink-0 rounded-full bg-foreground/70" data-unread-dot role="img" />
			) : null}
		</button>
	);
}

/** Lista compartilhada pela sidebar e pela folha do celular. */
export function ActiveWorkList({ rows, onOpen }: { rows: readonly ActiveWorkRow[]; onOpen: (item: ActiveWorkItemResponse) => void }) {
	const now = useNow(rows.some((row) => row.state === "working" || row.state === "waiting"));
	return (
		<ul className="flex flex-col gap-0.5">
			{rows.map((row) => (
				<li key={row.key}>
					<ActiveWorkRowView now={now} onOpen={onOpen} row={row} />
				</li>
			))}
		</ul>
	);
}

/** Abrir um item: marca como visto e entrega ao app (navegar para a conversa e abrir o painel). */
function useOpenItem(onOpenItem: (item: ActiveWorkItemResponse) => void) {
	return (item: ActiveWorkItemResponse) => {
		markActiveWorkSeen(item.id);
		onOpenItem(item);
	};
}

/** Sidebar (desktop): seção pequena e recolhível acima da lista de conversas; some quando não há nada. */
export function ActiveWorkSidebarSection({ onOpenItem }: { onOpenItem: (item: ActiveWorkItemResponse) => void }) {
	const { rows, running } = useActiveWork();
	const [open, setOpen] = useState(true);
	const openItem = useOpenItem(onOpenItem);
	if (rows.length === 0) return null;
	return (
		<section aria-label="Em andamento" className="px-2 pt-1 pb-2" data-active-work-section>
			<button
				aria-expanded={open}
				className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left font-medium text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
				onClick={() => setOpen((value) => !value)}
				type="button"
			>
				<ChevronDownIcon className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
				<span>Em andamento</span>
				<span className="tabular-nums">{running > 0 ? running : rows.length}</span>
			</button>
			{open ? <ActiveWorkList onOpen={openItem} rows={rows.slice(0, 6)} /> : null}
		</section>
	);
}

/** Celular: uma linha na home de Conversas (contagem) que abre uma folha com os itens. */
export function ActiveWorkMobileRow({ onOpenItem }: { onOpenItem: (item: ActiveWorkItemResponse) => void }) {
	const { rows, running, unread } = useActiveWork();
	const [open, setOpen] = useState(false);
	const openItem = useOpenItem((item) => {
		setOpen(false);
		onOpenItem(item);
	});
	if (rows.length === 0) return null;
	return (
		<>
			<button
				className="mb-4 flex min-h-12 w-full items-center gap-3 rounded-2xl bg-card px-3 text-left active:bg-card/60"
				data-active-work-mobile-row
				onClick={() => setOpen(true)}
				type="button"
			>
				<span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
					<ListTodoIcon className="size-4" />
				</span>
				<span className="min-w-0 flex-1 truncate font-medium text-sm">Em andamento</span>
				<span className="shrink-0 rounded-full bg-muted px-2 py-0.5 font-medium text-xs tabular-nums">{running > 0 ? running : rows.length}</span>
				{unread > 0 ? <span aria-label="Há itens novos" className="size-2 shrink-0 rounded-full bg-foreground/70" role="img" /> : null}
				<ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
			</button>
			<Sheet onOpenChange={setOpen} open={open}>
				<SheetContent className="rounded-t-3xl pb-[max(1.5rem,env(safe-area-inset-bottom))]" showCloseButton={false} side="bottom">
					<SheetTitle className="px-5 pt-5 pb-2 font-semibold text-base">Em andamento</SheetTitle>
					<div className="max-h-[70dvh] overflow-y-auto px-3 pb-2">
						<ActiveWorkList onOpen={openItem} rows={rows} />
					</div>
				</SheetContent>
			</Sheet>
		</>
	);
}
