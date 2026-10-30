"use client";

import { CheckCircle2Icon, ChevronDownIcon, CircleDashedIcon, CircleIcon, PlayIcon, RotateCcwIcon, CircleStopIcon, SquareTerminalIcon, TerminalIcon, XCircleIcon } from "lucide-react";
import { Spinner } from "@workspace/ui/components/spinner";
import { useEffect, useRef, useState } from "react";
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
import { Button } from "@workspace/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { cn } from "@workspace/ui/lib/utils";

import {
	canResumeDevSession,
	canStopDevSession,
	formatTokens,
	resumeDevSessionNow,
	stopDevCommand,
	stopDevSessionNow,
} from "@/lib/dev-session/actions";
import { parseDiffLines } from "@/lib/dev-session/diff";
import { ContextMeter } from "./context-meter";
import { useOpenRouterModels } from "@/hooks/use-openrouter-models";
import { devModelLabel } from "@/lib/dev-session/model-label";
import {
	devIsWorking,
	devAverageFirstTokenMs,
	devTimingParts,
	devStatusTone,
	devChangedFiles,
	devSessionTitle,
	devPillLabel,
	devSetupLabel,
	isBackgroundCommand,
	formatElapsed,
	formatElapsedLong,
	stripAnsi,
	type DevCommandView,
	type DevSessionView,
	type DevSetupStepView,
} from "@/lib/dev-session/reducer";
import { useDevSession, useNow } from "@/lib/dev-session/store";
import { useCiPolling } from "@/lib/dev-session/use-ci-polling";

import { CopyButton, StatusPill } from "./parts";
import { PullRequestBody } from "./pr-section";
import { buildTestPrMessage } from "@workspace/shared";
import { requestChatMessage } from "@/lib/dev-session/chat-send-request";
import { formatNumber } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/provider";

/** Ações do painel (ausentes em pré-visualizações e testes de apresentação). */
export type DevSessionActions = {
	onStopCommand: (command: DevCommandView) => void;
	onStopSession: () => void;
	onResume: () => void;
	/** "Testar de novo": pede ao agente para testar a PR da sessão outra vez. */
	onRetestPr?: () => void;
	/** Ação em andamento (desabilita os botões). */
	busy?: boolean;
};

function commandMs(command: DevCommandView, now: number): number {
	return command.durationMs ?? Math.max(0, now - command.startedAt);
}

function commandFailed(command: DevCommandView): boolean {
	if (command.endedReason === "stopped" || command.endedReason === "lost") return false;
	return command.status === "done" && (command.exitCode !== 0 || command.endedReason === "timeout" || command.endedReason === "killed");
}

/** Selo de saída do comando: ✓ 0 ou ✗ código. */
export function ExitBadge({ command }: { command: DevCommandView }) {
	const { t } = useTranslations();
	if (command.status === "running") return null;
	const ok = !commandFailed(command);
	const label =
		command.endedReason === "timeout"
			? t("devSession.detail.exit.timeout")
			: command.endedReason === "killed"
				? t("devSession.detail.exit.killed")
				: command.endedReason === "stopped"
					? t("devSession.detail.exit.stopped")
					: command.endedReason === "lost"
						? t("devSession.detail.exit.lost")
						: ok
					? "✓ 0"
					: `✗ ${command.exitCode ?? t("devSession.detail.exit.error")}`;
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-full px-1.5 font-mono text-caption",
				ok ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive",
			)}
			data-exit-badge
		>
			{label}
		</span>
	);
}

/** Saída do terminal (ANSI removido; linhas longas rolam na horizontal), rolando para o fim enquanto roda. */
export function TerminalOutput({ command, maxHeight = "max-h-64" }: { command: DevCommandView; maxHeight?: string }) {
	const { t } = useTranslations();
	const ref = useRef<HTMLPreElement>(null);
	const stick = useRef(true);
	const text = stripAnsi(command.output);
	useEffect(() => {
		const element = ref.current;
		if (element && command.status === "running" && stick.current) element.scrollTop = element.scrollHeight;
	}, [text, command.status]);
	if (!text.trim() && command.status !== "running") {
		return <p className="px-3 py-2 text-muted-foreground text-xs">{t("devSession.detail.noOutput")}</p>;
	}
	return (
		<pre
			className={cn("overflow-auto whitespace-pre px-3 py-2 font-mono text-caption leading-relaxed", maxHeight)}
			onScroll={(event) => {
				const el = event.currentTarget;
				stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
			}}
			ref={ref}
		>
			{command.truncated ? <span className="text-muted-foreground">{t("devSession.detail.outputOmitted")}{"\n"}</span> : null}
			{text}
		</pre>
	);
}

function Section({
	title,
	count,
	defaultOpen = true,
	children,
}: {
	title: string;
	count?: number;
	defaultOpen?: boolean;
	children: React.ReactNode;
}) {
	return (
		<Collapsible className="min-w-0" defaultOpen={defaultOpen}>
			<CollapsibleTrigger className="group/section flex w-full items-center gap-1.5 rounded-md py-1 text-left font-medium text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
				<span>{title}</span>
				{count !== undefined ? <span className="text-muted-foreground text-xs">{count}</span> : null}
				<ChevronDownIcon className="ml-auto size-4 text-muted-foreground transition-transform group-data-[panel-open]/section:rotate-180" />
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="pt-1.5">{children}</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

function SubGroup({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
	return (
		<Collapsible className="min-w-0" defaultOpen>
			<CollapsibleTrigger className="group/sub flex w-full items-center gap-1.5 py-1 text-left text-muted-foreground text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
				<ChevronDownIcon className="size-3.5 -rotate-90 transition-transform group-data-[panel-open]/sub:rotate-0" />
				<span>{title}</span>
				<span>{count}</span>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<ul className="flex flex-col gap-1.5 pt-1">{children}</ul>
			</CollapsibleContent>
		</Collapsible>
	);
}

/** Comando como item de lista: 2 linhas de comando + "Shell · tempo"; expande para saída completa. */
export function CommandItem({ command, now, onStop }: { command: DevCommandView; now: number; onStop?: (command: DevCommandView) => void }) {
	const { t } = useTranslations();
	const running = command.status === "running";
	const failed = commandFailed(command);
	const stoppable = running && onStop !== undefined;
	return (
		<li className="relative" data-command-item>
			{stoppable ? (
				<Button
					aria-label={t("devSession.detail.stopCommand")}
					className="absolute top-2 right-9 z-10"
					data-stop-command
					onClick={() => onStop(command)}
					size="icon-xs"
					title={t("devSession.detail.stopCommand")}
					type="button"
					variant="ghost"
				>
					<CircleStopIcon />
				</Button>
			) : null}
			<Collapsible className="min-w-0 overflow-hidden rounded-xl bg-muted/40">
				<CollapsibleTrigger className={cn("group/cmd flex w-full items-start gap-2.5 px-3 py-2.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50", stoppable && "pr-16")}>
					<TerminalIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
					<span className="min-w-0 flex-1">
						<span className="line-clamp-2 break-all font-mono text-xs">{command.cmd}</span>
						<span className="mt-0.5 block text-muted-foreground text-xs tabular-nums">
							{t("devSession.detail.shell")} ·{" "}
							{running ? (
								formatElapsedLong(commandMs(command, now))
							) : (
								<>
									<span className={cn(failed && "text-destructive")}>{failed ? (command.endedReason === "killed" ? t("devSession.detail.cmdInterrupted") : command.endedReason === "timeout" ? t("devSession.detail.cmdTimeout") : t("devSession.detail.cmdFailed")) : command.endedReason === "stopped" ? t("devSession.detail.cmdStopped") : command.endedReason === "lost" ? t("devSession.detail.cmdLost") : t("devSession.detail.cmdDone")}</span>
									{" · "}
									{formatElapsedLong(commandMs(command, now))}
								</>
							)}
						</span>
					</span>
					<ChevronDownIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/cmd:rotate-180" />
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div className="border-t border-border/60">
						<div className="flex items-start gap-2 px-3 py-1.5">
							<code className="min-w-0 flex-1 whitespace-pre-wrap wrap-break-word font-mono text-xs">
								<span className="select-none text-muted-foreground">$ </span>
								{command.cmd}
							</code>
							<CopyButton label={t("devSession.detail.copyCommand")} text={command.cmd} />
						</div>
						<TerminalOutput command={command} />
						<div className="flex items-center justify-between gap-2 px-3 py-1.5 text-muted-foreground text-xs">
							<ExitBadge command={command} />
							<CopyButton label={t("devSession.detail.copyOutput")} text={stripAnsi(command.output)} />
						</div>
					</div>
				</CollapsibleContent>
			</Collapsible>
		</li>
	);
}

export function DiffStat({ added, removed }: { added: number; removed: number }) {
	return (
		<span className="shrink-0 font-mono text-caption tabular-nums">
			<span className="text-success">+{added}</span>{" "}
			<span className="text-destructive">−{removed}</span>
		</span>
	);
}

const DIFF_LINE_CLASS = {
	add: "bg-success/15 text-success",
	remove: "bg-destructive/15 text-destructive",
	hunk: "bg-info/10 text-info",
	meta: "text-muted-foreground",
	context: "text-foreground/80",
} as const;

export function DiffView({ diff }: { diff: string }) {
	const lines = parseDiffLines(diff);
	return (
		<div className="overflow-x-auto py-1 font-mono text-caption leading-relaxed" data-diff-view>
			<div className="w-max min-w-full">
				{lines.map((line, index) => (
					<div
						className={cn("whitespace-pre px-3", DIFF_LINE_CLASS[line.kind])}
						data-diff-line={line.kind}
						// biome-ignore lint/suspicious/noArrayIndexKey: linhas de diff não têm id
						key={index}
					>
						{line.text || " "}
					</div>
				))}
			</div>
		</div>
	);
}

function ChangesSection({ view }: { view: DevSessionView }) {
	const { t } = useTranslations();
	const files = devChangedFiles(view);
	return (
		<Section count={files.length > 0 ? files.length : undefined} title={t("devSession.detail.changes")}>
			{files.length === 0 ? (
				<p className="py-2 text-muted-foreground text-xs">{t("devSession.detail.noChanges")}</p>
			) : (
				<ul className="flex flex-col gap-1.5">
					{files.map((file) => (
						<li key={file.path}>
							<Collapsible className="min-w-0 overflow-hidden rounded-xl bg-muted/40">
								<CollapsibleTrigger className="group/file flex w-full items-center gap-2 px-3 py-2 text-left text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
									<span className="min-w-0 flex-1 truncate font-mono" dir="rtl">
										<bdi>{file.path}</bdi>
									</span>
									<DiffStat added={file.added} removed={file.removed} />
									<ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/file:rotate-180" />
								</CollapsibleTrigger>
								<CollapsibleContent>
									<div className="border-t border-border/60">
										{file.diffs.length > 0 ? (
											file.diffs.map((diff, index) => (
												// biome-ignore lint/suspicious/noArrayIndexKey: ordem fixa
												<DiffView diff={diff} key={index} />
											))
										) : (
											<p className="px-3 py-2 text-muted-foreground text-xs">{t("devSession.detail.diffUnavailable")}</p>
										)}
									</div>
								</CollapsibleContent>
							</Collapsible>
						</li>
					))}
				</ul>
			)}
		</Section>
	);
}

function PullRequestSection({ view, actions }: { view: DevSessionView; actions?: DevSessionActions }) {
	const { t } = useTranslations();
	if (!view.pr) return null;
	const canRetest = actions?.onRetestPr && (view.pr.state === "open" || view.pr.state === "draft");
	return (
		<Section title={t("devSession.detail.pullRequest")}>
			<PullRequestBody ci={view.ci} pr={view.pr} />
			{canRetest ? (
				<Button className="mt-2 self-start" data-retest-pr onClick={actions.onRetestPr} size="sm" type="button" variant="outline">
					<RotateCcwIcon />
					{t("devSession.detail.retest")}
				</Button>
			) : null}
		</Section>
	);
}

/** Concluídas visíveis por padrão (as mais recentes); o resto fica atrás de "Ver todas". */
export const DEV_DONE_VISIBLE = 5;

/** Só o que foi de fato para segundo plano (comando curto de primeiro plano não é "tarefa"). */
export function backgroundCommands(commands: readonly DevCommandView[]): DevCommandView[] {
	return commands.filter(isBackgroundCommand);
}

function CommandsSection({ view, now, actions }: { view: DevSessionView; now: number; actions?: DevSessionActions }) {
	const { t } = useTranslations();
	const [showAll, setShowAll] = useState(false);
	const tasks = backgroundCommands(view.commands);
	const running = tasks.filter((c) => c.status === "running");
	const done = tasks.filter((c) => c.status === "done");
	const doneNewestFirst = [...done].reverse();
	const shownDone = showAll ? doneNewestFirst : doneNewestFirst.slice(0, DEV_DONE_VISIBLE);
	return (
		<Section count={tasks.length > 0 ? tasks.length : undefined} title={t("devSession.detail.background")}>
			{tasks.length === 0 ? (
				<p className="py-2 text-muted-foreground text-xs">{t("devSession.detail.noBackground")}</p>
			) : (
				<div className="flex flex-col gap-1">
					{running.length > 0 ? (
						<SubGroup count={running.length} title={t("devSession.detail.runningGroup")}>
							{running.map((command) => (
								<CommandItem command={command} key={command.callId} now={now} onStop={actions?.onStopCommand} />
							))}
						</SubGroup>
					) : null}
					{done.length > 0 ? (
						<SubGroup count={done.length} title={t("devSession.detail.doneGroup")}>
							{shownDone.map((command) => (
								<CommandItem command={command} key={command.callId} now={now} />
							))}
							{done.length > DEV_DONE_VISIBLE ? (
								<li>
									<Button className="w-full text-muted-foreground" data-show-all-done onClick={() => setShowAll((value) => !value)} size="sm" type="button" variant="ghost">
										{showAll ? t("devSession.detail.showLess") : t("devSession.detail.showAll", { count: done.length })}
									</Button>
								</li>
							) : null}
						</SubGroup>
					) : null}
				</div>
			)}
		</Section>
	);
}

/** Instalação e inicialização do ambiente do repositório, com o fim da saída de cada passo. */
function PreparationSection({ view, now }: { view: DevSessionView; now: number }) {
	const { t } = useTranslations();
	const steps = view.setup.filter((step) => step.step === "detect" || step.step === "install" || step.step === "start");
	if (steps.length === 0 && view.envNotes.length === 0) return null;
	return (
		<Section title={t("devSession.detail.preparation")}>
			<div className="flex flex-col gap-1" data-dev-preparation>
				{steps.map((step) => (
					<PreparationItem key={step.step} now={now} step={step} />
				))}
				{view.envNotes.map((note) => (
					<p className="flex items-center gap-2 rounded-xl bg-muted/40 px-3 py-2 text-xs text-muted-foreground" data-dev-env-note key={note}>
						<CheckCircle2Icon className="size-3.5 shrink-0 text-success" />
						{note}
					</p>
				))}
			</div>
		</Section>
	);
}

function PreparationItem({ step, now }: { step: DevSetupStepView; now: number }) {
	const translator = useTranslations();
	const ms = step.durationMs ?? Math.max(0, now - step.startedAt);
	const label = devSetupLabel(step.step, step.cache, step.status === "done" ? step.durationMs : undefined, translator);
	const labelHasTime = step.cache === "hit" && step.status === "done" && step.durationMs !== undefined;
	const head = (
		<span className="flex min-w-0 flex-1 items-center gap-2">
			{step.status === "running" ? (
				<Spinner className="size-3.5 shrink-0 text-muted-foreground" />
			) : step.status === "failed" ? (
				<XCircleIcon className="size-3.5 shrink-0 text-destructive" />
			) : (
				<CheckCircle2Icon className="size-3.5 shrink-0 text-success" />
			)}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{labelHasTime ? null : <span className="shrink-0 font-mono text-caption text-muted-foreground">{formatElapsed(ms)}</span>}
		</span>
	);
	if (!step.output?.trim()) return <div className="flex items-center rounded-xl bg-muted/40 px-3 py-2 text-xs">{head}</div>;
	return (
		<Collapsible className="min-w-0 overflow-hidden rounded-xl bg-muted/40 text-xs" defaultOpen={step.status === "failed"}>
			<CollapsibleTrigger className="group/prep flex w-full items-center gap-2 px-3 py-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
				{head}
				<ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/prep:rotate-180" />
			</CollapsibleTrigger>
			<CollapsibleContent>
				<pre className="max-h-48 overflow-auto whitespace-pre border-border/60 border-t px-3 py-2 font-mono text-caption leading-relaxed">{stripAnsi(step.output)}</pre>
			</CollapsibleContent>
		</Collapsible>
	);
}

/** "Tempo": onde a sessão gastou o tempo (modelo, comandos, aprovação, preparação). */
function TimingSection({ view }: { view: DevSessionView }) {
	const translator = useTranslations();
	const { t, locale } = translator;
	const parts = devTimingParts(view, translator);
	if (!parts) return null;
	const firstToken = devAverageFirstTokenMs(view);
	return (
		<Section title={t("devSession.detail.timing")}>
			<p className="rounded-xl bg-muted/40 px-3 py-2 text-xs leading-relaxed" data-dev-timing>
				{parts.map((part) => part.text).join(" · ")}
			</p>
			{firstToken !== null ? <p className="px-3 pt-1 text-muted-foreground text-xs">{t("devSession.detail.firstToken", { seconds: formatNumber(Number((firstToken / 1000).toFixed(1)), locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</p> : null}
		</Section>
	);
}

function PlanSection({ view }: { view: DevSessionView }) {
	const { t } = useTranslations();
	if (view.todos.length === 0) return null;
	const done = view.todos.filter((todo) => todo.status === "completed").length;
	return (
		<Section title={t("devSession.detail.plan", { done, total: view.todos.length })}>
			<ul className="flex flex-col gap-1.5">
				{view.todos.map((todo) => (
					<li className="flex items-start gap-2 rounded-xl bg-muted/40 px-3 py-2 text-xs" key={todo.id}>
						<span className="mt-0.5 shrink-0">
							{todo.status === "completed" ? (
								<CheckCircle2Icon className="size-3.5 text-success" />
							) : todo.status === "in_progress" ? (
								<Spinner className="size-3.5 text-info" />
							) : todo.status === "cancelled" ? (
								<XCircleIcon className="size-3.5 text-muted-foreground" />
							) : (
								<CircleIcon className="size-3.5 text-muted-foreground" />
							)}
						</span>
						<span
							className={cn(
								"min-w-0 flex-1 wrap-break-word",
								(todo.status === "completed" || todo.status === "cancelled") && "text-muted-foreground",
								todo.status === "cancelled" && "line-through",
							)}
						>
							{todo.content}
						</span>
					</li>
				))}
			</ul>
		</Section>
	);
}

/** "Parar sessão" (com confirmação) e "Retomar", no cabeçalho do painel. */
function SessionActionsBar({ view, actions }: { view: DevSessionView; actions: DevSessionActions }) {
	const { t } = useTranslations();
	const [confirming, setConfirming] = useState(false);
	if (canStopDevSession(view)) {
		return (
			<>
				<Button
					className="self-start"
					data-stop-session
					disabled={actions.busy}
					onClick={() => setConfirming(true)}
					size="sm"
					type="button"
					variant="outline"
				>
					<CircleStopIcon />
					{t("devSession.detail.stopSession")}
				</Button>
				<AlertDialog onOpenChange={setConfirming} open={confirming}>
					<AlertDialogContent size="sm">
						<AlertDialogHeader>
							<AlertDialogTitle>{t("devSession.detail.stopTitle")}</AlertDialogTitle>
							<AlertDialogDescription>
								{t("devSession.detail.stopText")}
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
							<AlertDialogAction
								onClick={() => {
									setConfirming(false);
									actions.onStopSession();
								}}
								variant="destructive"
							>
								{t("devSession.detail.stopSession")}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</>
		);
	}
	if (canResumeDevSession(view)) {
		return (
			<Button className="self-start" data-resume-session disabled={actions.busy} onClick={actions.onResume} size="sm" type="button" variant="outline">
				<PlayIcon />
				{t("devSession.detail.resume")}
			</Button>
		);
	}
	return null;
}

/** Modelo em uso na sessão (texto discreto ao lado do medidor de contexto). */
function DevModelName({ model }: { model: string }) {
	const { models } = useOpenRouterModels();
	return (
		<span className="min-w-0 truncate text-muted-foreground text-xs" data-dev-model title={model}>
			{devModelLabel(model, models)}
		</span>
	);
}

export function DevSessionDetailView({ view, now, actions }: { view: DevSessionView; now: number; actions?: DevSessionActions }) {
	const translator = useTranslations();
	const { t } = translator;
	const lastCompaction = view.compactions.at(-1);
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-4 pb-4" data-dev-session-detail>
			<div className="flex min-w-0 flex-col gap-2">
				<div className="flex min-w-0 items-center gap-2">
					<SquareTerminalIcon className="size-4 shrink-0 text-muted-foreground" />
					<h3 className="min-w-0 flex-1 truncate font-semibold text-sm">{devSessionTitle(view, translator)}</h3>
				</div>
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
					<StatusPill label={devPillLabel(view, now, translator)} tone={devStatusTone(view)} />
					{view.contextUsage ? <ContextMeter usage={view.contextUsage} /> : null}
					{view.contextUsage?.model ? <DevModelName model={view.contextUsage.model} /> : null}
				</div>
				{lastCompaction ? (
					<p className="text-muted-foreground text-xs tabular-nums" data-context-summary>
						{t("devSession.detail.summarySizes", {
							summary: view.compactions.length > 1 ? t("devSession.detail.summarizedTimes", { count: view.compactions.length }) : t("devSession.detail.summarized"),
							before: formatTokens(lastCompaction.before),
							after: formatTokens(lastCompaction.after),
						})}
					</p>
				) : null}
				{actions ? <SessionActionsBar actions={actions} view={view} /> : null}
			</div>
			<PreparationSection now={now} view={view} />
			<ChangesSection view={view} />
			<PullRequestSection actions={actions} view={view} />
			<CommandsSection actions={actions} now={now} view={view} />
			<PlanSection view={view} />
			<TimingSection view={view} />
		</div>
	);
}

/** Detalhe ligado ao store (coluna 3). */
export function DevSessionDetail({ sessionId }: { sessionId: string }) {
	const { t } = useTranslations();
	const view = useDevSession(sessionId);
	const now = useNow(view ? devIsWorking(view) : false);
	useCiPolling(sessionId, view);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!view) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground text-xs">
				<CircleDashedIcon className="size-5" />
				{t("devSession.detail.notFound")}
			</div>
		);
	}
	const run = async (task: () => Promise<void>, failure: string) => {
		setBusy(true);
		setError(null);
		try {
			await task();
		} catch {
			setError(failure);
		} finally {
			setBusy(false);
		}
	};
	const actions: DevSessionActions = {
		busy,
		onStopCommand: (command) => void run(() => stopDevCommand(sessionId, command), t("devSession.detail.stopCommandError")),
		onStopSession: () => void run(() => stopDevSessionNow(sessionId), t("devSession.detail.stopSessionError")),
		onResume: () => void run(() => resumeDevSessionNow(sessionId), t("devSession.detail.resumeError")),
		onRetestPr: view.pr && view.repo ? () => requestChatMessage(buildTestPrMessage({ repo: view.repo!, number: view.pr!.number })) : undefined,
	};
	return (
		<>
			{error ? (
				<p className="px-4 pb-2 text-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
			<DevSessionDetailView actions={actions} now={now} view={view} />
		</>
	);
}
