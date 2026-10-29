"use client";

import { CheckCircle2Icon, ClockIcon, ExternalLinkIcon, GitPullRequestIcon, Loader2Icon, MinusCircleIcon, XCircleIcon } from "lucide-react";
import { Badge } from "@workspace/ui/components/badge";
import { cn } from "@workspace/ui/lib/utils";
import { ciCheckFailed, ciSummaryText, DEV_PR_STATE_LABEL, type DevCiCheck, type DevPrInfo, type DevPrState } from "@workspace/shared";

import { formatElapsed, type DevCiView } from "@/lib/dev-session/reducer";

/** Só abrimos links http(s) vindos do GitHub no painel (nunca `javascript:` ou similares). */
export function safeExternalUrl(url: string | undefined): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
	} catch {
		return null;
	}
}

export type CheckVisual = "passed" | "failed" | "skipped" | "running" | "queued";

/** Ícone/estado de cada verificação: ✓ passou, ✗ falhou, spinner rodando, relógio na fila, traço ignorada. */
export function checkVisual(check: Pick<DevCiCheck, "status" | "conclusion">): CheckVisual {
	if (check.status === "queued") return "queued";
	if (check.status === "in_progress") return "running";
	if (ciCheckFailed(check)) return "failed";
	return check.conclusion === "skipped" || check.conclusion === "neutral" ? "skipped" : "passed";
}

const CHECK_LABEL: Record<CheckVisual, string> = {
	passed: "Passou",
	failed: "Falhou",
	skipped: "Ignorada",
	running: "Em andamento",
	queued: "Na fila",
};

function CheckIcon({ visual }: { visual: CheckVisual }) {
	switch (visual) {
		case "passed":
			return <CheckCircle2Icon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />;
		case "failed":
			return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />;
		case "running":
			return <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />;
		case "queued":
			return <ClockIcon className="size-3.5 shrink-0 text-muted-foreground" />;
		default:
			return <MinusCircleIcon className="size-3.5 shrink-0 text-muted-foreground" />;
	}
}

const PR_DOT: Record<DevPrState, string> = {
	open: "bg-emerald-500",
	draft: "bg-muted-foreground/60",
	merged: "bg-sky-500",
	closed: "bg-destructive",
};

/** Pílula neutra do estado do PR: só o ponto carrega cor. */
export function PrStatePill({ state }: { state: DevPrState }) {
	return (
		<Badge className="shrink-0 bg-muted font-medium text-foreground/80" data-pr-state={state} variant="ghost">
			<span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", PR_DOT[state])} />
			{DEV_PR_STATE_LABEL[state]}
		</Badge>
	);
}

function ExternalLink({ href, label, children, className }: { href: string; label?: string; children: React.ReactNode; className?: string }) {
	return (
		<a
			aria-label={label}
			className={cn("inline-flex items-center gap-1 rounded-md outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50", className)}
			href={href}
			rel="noopener noreferrer"
			target="_blank"
		>
			{children}
		</a>
	);
}

function CheckRow({ check }: { check: DevCiCheck }) {
	const visual = checkVisual(check);
	const href = safeExternalUrl(check.url);
	return (
		<li className="flex items-center gap-2 rounded-xl bg-muted/40 px-3 py-2 text-xs" data-ci-check data-ci-state={visual}>
			<span aria-label={CHECK_LABEL[visual]} className="grid shrink-0 place-items-center" role="img">
				<CheckIcon visual={visual} />
			</span>
			<span className="min-w-0 flex-1 truncate" title={check.name}>
				{check.name}
			</span>
			{check.durationMs !== undefined ? <span className="shrink-0 font-mono text-caption text-muted-foreground tabular-nums">{formatElapsed(check.durationMs)}</span> : null}
			{href ? (
				<ExternalLink className="shrink-0 text-muted-foreground" href={href} label={`Abrir ${check.name} no GitHub`}>
					<ExternalLinkIcon className="size-3.5" />
				</ExternalLink>
			) : null}
		</li>
	);
}

/** Conteúdo da seção "Pull request": cabeçalho do PR, link externo e a lista de checks. */
export function PullRequestBody({ pr, ci }: { pr: DevPrInfo; ci?: DevCiView }) {
	const href = safeExternalUrl(pr.url);
	return (
		<div className="flex flex-col gap-2" data-dev-pr>
			<div className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-muted/40 px-3 py-2.5 text-xs">
				<div className="flex min-w-0 items-start gap-2">
					<GitPullRequestIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
					<span className="line-clamp-2 min-w-0 flex-1 wrap-break-word font-medium text-sm" title={pr.title}>
						<span className="font-mono text-muted-foreground">#{pr.number}</span> {pr.title}
					</span>
					<PrStatePill state={pr.state} />
				</div>
				<p className="truncate font-mono text-caption text-muted-foreground" data-pr-branches title={`${pr.base} ← ${pr.head}`}>
					{pr.base} ← {pr.head}
				</p>
				{href ? (
					<ExternalLink className="self-start text-muted-foreground" href={href}>
						Abrir no GitHub
						<ExternalLinkIcon className="size-3.5" />
					</ExternalLink>
				) : null}
			</div>
			<div className="flex min-w-0 flex-col gap-1.5" data-dev-ci>
				<p className="flex items-center gap-1.5 text-muted-foreground text-xs tabular-nums" data-ci-summary>
					<span>Checks</span>
					<span aria-hidden="true">·</span>
					{!ci ? (
						<span className="inline-flex items-center gap-1">
							<Loader2Icon className="size-3 animate-spin" />
							Verificando…
						</span>
					) : ci.checks.length === 0 ? (
						<span>Sem verificações ainda</span>
					) : (
						<span>{ciSummaryText(ci.checks)}</span>
					)}
				</p>
				{ci && ci.checks.length > 0 ? (
					<ul className="flex flex-col gap-1.5">
						{ci.checks.map((check) => (
							<CheckRow check={check} key={check.name} />
						))}
					</ul>
				) : null}
			</div>
		</div>
	);
}
