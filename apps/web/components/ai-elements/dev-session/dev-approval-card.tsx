"use client";

import { CheckIcon, EllipsisVerticalIcon, FilePenLineIcon, ShieldAlertIcon, SquareTerminalIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { DevApprovalCardInfo } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@workspace/ui/components/dropdown-menu";
import { REQUEST_PRIMARY_CLASS, RequestCard } from "@workspace/ui/components/request-card";
import { Textarea } from "@workspace/ui/components/textarea";
import { cn } from "@workspace/ui/lib/utils";
import { devApprovalOptions } from "@/lib/dev-approval-options";

type Status = "pending" | "approved" | "rejected" | "failed";

const BADGE = {
	pending: { tone: "pending", label: "Precisa de você" },
	approved: { tone: "success", label: "Aprovado" },
	rejected: { tone: "danger", label: "Recusado" },
	failed: { tone: "danger", label: "Falhou" },
} as const;

export type DevApprovalCardProps = {
	info: DevApprovalCardInfo;
	title: string;
	status?: Status;
	confirmLabel?: string;
	cancelLabel?: string;
	disabled?: boolean;
	onConfirm?: () => void;
	/** "Sempre neste repositório": salva os prefixos na lista do repositório e executa. */
	onAlways?: () => void;
	onSkip?: () => void;
	onReject?: (feedback: string) => void;
};

/** Linhas do diff com tom discreto (neutro; verde/vermelho só no texto). */
function DiffPreview({ text }: { text: string }) {
	const lines = text.split("\n");
	return (
		<pre className="m-0 max-h-56 overflow-auto rounded-xl bg-background/70 px-3 py-2 font-mono text-xs leading-5" data-dev-approval-diff>
			{lines.map((line, index) => (
				<span
					className={cn("block whitespace-pre-wrap [overflow-wrap:anywhere]", line.startsWith("+") && "text-success", line.startsWith("-") && "text-destructive")}
					key={`${index}-${line.slice(0, 12)}`}
				>
					{line || " "}
				</span>
			))}
		</pre>
	);
}

function Meta({ items }: { items: Array<string | undefined> }) {
	const shown = items.filter(Boolean);
	if (!shown.length) return null;
	return (
		<p className="m-0 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-muted-foreground text-xs" data-dev-approval-meta>
			{shown.map((item, index) => (
				<span className="min-w-0 [overflow-wrap:anywhere]" key={`${index}-${item}`}>
					{index > 0 ? <span aria-hidden="true" className="mr-2">·</span> : null}
					{item}
				</span>
			))}
		</p>
	);
}

/**
 * Aprovação de comando ou escrita de arquivo numa sessão de código: mostra o
 * comando inteiro (mono), onde roda e o que fazer — Executar, Sempre permitir,
 * Agora não ou Recusar com comentário. Decidido, só o selo e os detalhes ficam.
 */
export function DevApprovalCard({ info, title, status = "pending", confirmLabel, cancelLabel = "Agora não", disabled, onConfirm, onAlways, onSkip, onReject }: DevApprovalCardProps) {
	const [rejecting, setRejecting] = useState(false);
	const [feedback, setFeedback] = useState("");
	const resolved = status !== "pending";
	const isCommand = info.kind === "command";
	const prefixes = info.kind === "command" ? (info.prefixes ?? []) : [];
	const options = devApprovalOptions({ prefixes, canAlways: Boolean(onAlways), cancelLabel });
	const where = [info.repo, info.branch].filter(Boolean).join(" · ");

	return (
		<RequestCard
			actions={
				<>
					<Button className={REQUEST_PRIMARY_CLASS} disabled={disabled} onClick={onConfirm} size="sm" type="button">
						{confirmLabel ?? (isCommand ? "Executar" : "Aplicar")}
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger
							render={<Button aria-label="Mais opções" data-dev-approval-more disabled={disabled} size="icon-sm" type="button" variant="ghost" />}
						>
							<EllipsisVerticalIcon />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="w-auto max-w-[20rem] min-w-44" side="top">
							{options.map((option) => (
								<DropdownMenuItem
									className="min-w-0"
									key={option.id}
									onClick={option.id === "once" ? onConfirm : option.id === "always" ? onAlways : onSkip}
									title={option.detail}
								>
									<span className="flex min-w-0 flex-col">
										<span className="truncate">{option.label}</span>
										{option.detail ? <span className="truncate text-muted-foreground text-xs">{option.detail}</span> : null}
									</span>
								</DropdownMenuItem>
							))}
							{onReject ? <DropdownMenuItem onClick={() => setRejecting(true)}>Recusar com comentário</DropdownMenuItem> : null}
						</DropdownMenuContent>
					</DropdownMenu>
				</>
			}
			badge={BADGE[status]}
			data-dev-approval
			description={info.reason}
			detailsLabel={isCommand ? "Ver comando" : "Ver alteração"}
			leading={status === "approved" ? <CheckIcon aria-label="Aprovado" /> : status === "rejected" ? <XIcon aria-label="Recusado" /> : <ShieldAlertIcon aria-label="Atenção" />}
			resolved={resolved}
			title={title}
		>
			{info.kind === "command" ? (
				<>
					<pre
						className="m-0 flex max-h-56 min-w-0 gap-2 overflow-auto rounded-xl bg-background/70 px-3 py-2 font-mono text-body leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]"
						data-dev-approval-command
					>
						<SquareTerminalIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
						<code className="min-w-0 flex-1 font-mono">{info.command}</code>
					</pre>
					<Meta items={[`em ${info.cwd}`, where]} />
				</>
			) : (
				<>
					<p className="m-0 flex min-w-0 items-center gap-1.5 font-mono text-body [overflow-wrap:anywhere]" data-dev-approval-path>
						<FilePenLineIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
						<span className="min-w-0">{info.path}</span>
					</p>
					{info.preview ? <DiffPreview text={info.preview} /> : null}
					<Meta items={[info.created ? "arquivo novo" : undefined, `+${info.added} −${info.removed}`, where]} />
				</>
			)}
			{!resolved && rejecting && onReject ? (
				<div className="flex min-w-0 flex-col gap-2" data-dev-approval-reject>
					<Textarea
						aria-label="Comentário para o agente"
						autoFocus
						className="min-h-16 text-sm"
						maxLength={500}
						onChange={(event) => setFeedback(event.target.value)}
						placeholder="Diga o que fazer de outro jeito"
						value={feedback}
					/>
					<div className="flex items-center gap-2">
						<Button disabled={disabled} onClick={() => onReject(feedback)} size="sm" type="button" variant="secondary">
							Recusar e enviar
						</Button>
						<Button onClick={() => setRejecting(false)} size="sm" type="button" variant="ghost">
							Voltar
						</Button>
					</div>
				</div>
			) : null}
		</RequestCard>
	);
}
