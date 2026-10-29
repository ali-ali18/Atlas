"use client";

import {
	INSPECT_CATEGORIES,
	type InspectAction,
	type InspectApproval,
	type InspectCategory,
	type InspectStepView,
	type InspectToolCall,
	type RunInspection,
} from "@workspace/shared";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { cn } from "@workspace/ui/lib/utils";

import { formatNumber, formatPercent } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/provider";
import { DEFAULT_UI_LOCALE, type UiLocale } from "@/lib/i18n/locales";
import { defaultTranslator, type MessageKey, type Translator } from "@/lib/i18n/translator";

/** Chaves dos rótulos e tons neutros (opacidade do texto) de cada categoria da barra empilhada. */
export const INSPECT_CATEGORY_META = {
	system: { label: "aiElements.inspector.cat.system", tone: "bg-foreground/80" },
	tools: { label: "aiElements.inspector.cat.tools", tone: "bg-foreground/60" },
	history: { label: "aiElements.inspector.cat.history", tone: "bg-foreground/45" },
	toolResults: { label: "aiElements.inspector.cat.toolResults", tone: "bg-foreground/30" },
	notes: { label: "aiElements.inspector.cat.notes", tone: "bg-foreground/20" },
	turn: { label: "aiElements.inspector.cat.turn", tone: "bg-foreground/10" },
} as const satisfies Record<InspectCategory, { label: MessageKey; tone: string }>;

const TRANSCRIPT_REASONS = {
	no_watermark: "aiElements.inspector.reason.no_watermark",
	corrupt: "aiElements.inspector.reason.corrupt",
	compact_mode: "aiElements.inspector.reason.compact_mode",
	seed_unavailable: "aiElements.inspector.reason.seed_unavailable",
	disabled: "aiElements.inspector.reason.disabled",
	group: "aiElements.inspector.reason.group",
	origin: "aiElements.inspector.reason.origin",
	no_conversation: "aiElements.inspector.reason.no_conversation",
} as const satisfies Record<string, MessageKey>;

const reasonText = (reason: string | undefined, fallback: string, { t }: Translator) =>
	reason && Object.hasOwn(TRANSCRIPT_REASONS, reason) ? t(TRANSCRIPT_REASONS[reason as keyof typeof TRANSCRIPT_REASONS]) : (reason ?? fallback);

const TOOL_STATUS = {
	ok: { label: "aiElements.inspector.tool.ok", variant: "secondary" },
	failed: { label: "aiElements.inspector.tool.failed", variant: "destructive" },
	running: { label: "aiElements.inspector.tool.running", variant: "outline" },
	uncertain: { label: "aiElements.inspector.tool.uncertain", variant: "outline" },
} as const satisfies Record<InspectToolCall["status"], { label: MessageKey; variant: "secondary" | "destructive" | "outline" }>;

const APPROVAL_STATUS = {
	pending: { label: "aiElements.inspector.approval.pending", variant: "outline" },
	approved: { label: "aiElements.inspector.approval.approved", variant: "secondary" },
	rejected: { label: "aiElements.inspector.approval.rejected", variant: "outline" },
	failed: { label: "aiElements.inspector.approval.failed", variant: "destructive" },
} as const satisfies Record<InspectApproval["status"], { label: MessageKey; variant: "secondary" | "destructive" | "outline" }>;

const PLAN_STATE_LABEL = {
	proposed: "aiElements.inspector.plan.proposed",
	approved: "aiElements.inspector.plan.approved",
	adjusted: "aiElements.inspector.plan.adjusted",
	cancelled: "aiElements.inspector.plan.cancelled",
} as const satisfies Record<NonNullable<InspectApproval["plan"]>["state"], MessageKey>;

/** Plano (`propose_plan`) deste run: quantos passos e o que o usuário decidiu. */
export function describePlan(approval: InspectApproval, translator: Translator = defaultTranslator): string | null {
	if (!approval.plan) return null;
	const { steps, state } = approval.plan;
	const stateText = translator.t(PLAN_STATE_LABEL[state]);
	return approval.title
		? translator.tn("aiElements.inspector.plan.titled", steps, { title: approval.title, state: stateText })
		: translator.tn("aiElements.inspector.plan.untitled", steps, { state: stateText });
}

const HOOK_ACTION_LABEL = {
	blocked: "aiElements.inspector.hook.blocked",
	confirm: "aiElements.inspector.hook.confirm",
	skipped: "aiElements.inspector.hook.skipped",
} as const satisfies Record<string, MessageKey>;

/** Uma linha por acerto do portão do plano ou de regra de lição. */
export function describeHookHit(hit: NonNullable<RunInspection["hooks"]>["hits"][number], { t }: Translator = defaultTranslator): string {
	if (hit.source === "plan") return t("aiElements.inspector.hook.plan", { tool: hit.tool });
	return t("aiElements.inspector.hook.rule", {
		ref: hit.ref ? ` [${hit.ref}]` : "",
		kind: hit.ruleKind ? ` (${hit.ruleKind})` : "",
		action: t(HOOK_ACTION_LABEL[hit.action]),
		tool: hit.tool,
		detail: hit.detail ? `: ${hit.detail}` : "",
	});
}

/** Hooks antes das ferramentas: o que o plano pendente e as regras das lições barraram neste run. */
export function HooksBlock({ hooks }: { hooks: NonNullable<RunInspection["hooks"]> }) {
	const translator = useTranslations();
	return (
		<div className="space-y-1 rounded-lg bg-muted px-3 py-2 text-xs" data-run-hooks>
			{hooks.hits.map((hit, index) => (
				<p className="break-words" key={index}>
					{describeHookHit(hit, translator)}
				</p>
			))}
			{hooks.helped.length > 0 ? <p>{translator.t("aiElements.inspector.hook.helped", { refs: hooks.helped.map((ref) => `[${ref}]`).join(" ") })}</p> : null}
		</div>
	);
}

export function formatTokens(value: number, locale: UiLocale = DEFAULT_UI_LOCALE): string {
	if (value >= 10_000) return `${Math.round(value / 1000)}k`;
	if (value >= 1000) return `${formatNumber(Number((value / 1000).toFixed(1)), locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k`;
	return String(Math.round(value));
}

function formatMs(ms: number, locale: UiLocale): string {
	return ms >= 1000 ? `${formatNumber(Number((ms / 1000).toFixed(1)), locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s` : `${Math.round(ms)} ms`;
}

export function describeAction(action: InspectAction, translator: Translator = defaultTranslator): string {
	const { t, tn, locale } = translator;
	const range = (before: number, after: number) => ({ before: formatTokens(before, locale), after: formatTokens(after, locale) });
	const hasRange = action.before !== undefined && action.after !== undefined;
	// No pt-BR o 0 cai no singular do plural do idioma ("0 grupo"): zero tem chave própria.
	switch (action.kind) {
		case "collapsed":
			return (action.count ?? 0) === 0 ? t("aiElements.inspector.action.collapsedZero") : tn("aiElements.inspector.action.collapsed", action.count ?? 0);
		case "trimmed":
			return (action.count ?? 0) === 0 ? t("aiElements.inspector.action.trimmedZero") : tn("aiElements.inspector.action.trimmed", action.count ?? 0);
		case "summary":
			return hasRange ? t("aiElements.inspector.action.summaryRange", range(action.before!, action.after!)) : t("aiElements.inspector.action.summary");
		case "summary_failed":
			return t("aiElements.inspector.action.summaryFailed");
		case "compaction":
			return hasRange ? t("aiElements.inspector.action.compactionRange", range(action.before!, action.after!)) : t("aiElements.inspector.action.compaction");
		case "compact":
			return hasRange ? t("aiElements.inspector.action.compactRange", range(action.before!, action.after!)) : t("aiElements.inspector.action.compact");
		case "guard":
			return action.detail === "hard" ? t("aiElements.inspector.action.guardHard") : t("aiElements.inspector.action.guardSoft");
	}
}

export function describeContext(context: NonNullable<RunInspection["context"]>, translator: Translator = defaultTranslator): string {
	const { t } = translator;
	const prior = context.priorMessages !== undefined ? t("aiElements.inspector.context.messages", { count: context.priorMessages }) : "";
	switch (context.mode) {
		case "carried":
			return t("aiElements.inspector.context.carried", { prior });
		case "seed":
			return t("aiElements.inspector.context.seed", { prior });
		case "fallback":
			return t("aiElements.inspector.context.fallback", { reason: reasonText(context.reason, t("aiElements.inspector.context.noReason"), translator) });
		case "first_turn":
			return t("aiElements.inspector.context.firstTurn");
		case "off":
			return t("aiElements.inspector.context.off", { reason: reasonText(context.reason, t("aiElements.inspector.context.notApplicable"), translator) });
	}
}

export function TokenBar({ tokens, scale }: { tokens: Record<InspectCategory, number>; scale: number }) {
	const { t } = useTranslations();
	const total = INSPECT_CATEGORIES.reduce((sum, key) => sum + tokens[key], 0);
	const width = scale > 0 ? Math.max(4, Math.round((total / scale) * 100)) : 100;
	return (
		<div
			aria-label={INSPECT_CATEGORIES.map((key) => `${t(INSPECT_CATEGORY_META[key].label)} ${tokens[key]}`).join(", ")}
			className="flex h-2.5 overflow-hidden rounded-full bg-muted"
			role="img"
			style={{ width: `${width}%` }}
		>
			{INSPECT_CATEGORIES.map((key) =>
				tokens[key] > 0 ? <span className={cn("h-full", INSPECT_CATEGORY_META[key].tone)} key={key} style={{ width: `${(tokens[key] / Math.max(1, total)) * 100}%` }} title={`${t(INSPECT_CATEGORY_META[key].label)}: ~${tokens[key]}`} /> : null,
			)}
		</div>
	);
}

function Legend() {
	const { t } = useTranslations();
	return (
		<ul className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground text-xs">
			{INSPECT_CATEGORIES.map((key) => (
				<li className="flex items-center gap-1.5" key={key}>
					<span aria-hidden className={cn("size-2 rounded-full", INSPECT_CATEGORY_META[key].tone)} />
					{t(INSPECT_CATEGORY_META[key].label)}
				</li>
			))}
		</ul>
	);
}

function StepCard({ step, scale }: { step: InspectStepView; scale: number }) {
	const translator = useTranslations();
	const { t, tn, locale } = translator;
	const facts = [
		step.provider,
		step.model ?? step.requestedModel,
		step.durationMs !== undefined ? formatMs(step.durationMs, locale) : undefined,
		step.finishReason ? t("aiElements.inspector.step.finish", { reason: step.finishReason }) : undefined,
	].filter(Boolean);
	return (
		<li className="space-y-2 rounded-xl border bg-card p-3" data-step={step.decisionIndex}>
			<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
				<span className="font-medium text-sm">{t("aiElements.inspector.step.title", { number: step.decisionIndex + 1 })}</span>
				<span className="min-w-0 truncate text-muted-foreground text-xs">{facts.join(" · ")}</span>
			</div>
			{step.tokens ? <TokenBar scale={scale} tokens={step.tokens} /> : <p className="text-muted-foreground text-xs">{t("aiElements.inspector.step.noBreakdown")}</p>}
			<p className="text-muted-foreground text-xs">
				{step.estimatedTotal !== undefined ? t("aiElements.inspector.step.estimated", { value: formatTokens(step.estimatedTotal, locale) }) : null}
				{step.promptTokens !== undefined ? `${step.estimatedTotal !== undefined ? " · " : ""}${t("aiElements.inspector.step.input", { value: formatTokens(step.promptTokens, locale) })}` : null}
				{step.completionTokens !== undefined ? ` · ${t("aiElements.inspector.step.output", { value: formatTokens(step.completionTokens, locale) })}` : null}
				{step.cacheReadTokens !== undefined ? ` · ${t("aiElements.inspector.step.cacheRead", { value: formatTokens(step.cacheReadTokens, locale) })}` : null}
				{step.cacheWriteTokens !== undefined ? ` · ${t("aiElements.inspector.step.cacheWrite", { value: formatTokens(step.cacheWriteTokens, locale) })}` : null}
				{step.contextLength !== undefined && step.estimatedTotal !== undefined ? ` · ${t("aiElements.inspector.step.window", { percent: formatPercent(step.estimatedTotal / step.contextLength, locale) })}` : null}
				{step.retries ? ` · ${tn("aiElements.inspector.step.retries", step.retries)}${step.retryReasons?.length ? ` (${step.retryReasons.join(", ")})` : ""}` : null}
			</p>
			{step.actions.length > 0 ? (
				<ul className="flex flex-wrap gap-1.5">
					{step.actions.map((action, index) => (
						<li key={`${action.kind}-${index}`}>
							<Badge variant={action.kind === "summary_failed" ? "destructive" : "outline"}>{describeAction(action, translator)}</Badge>
						</li>
					))}
				</ul>
			) : null}
			{step.toolNames && step.toolNames.length > 0 ? (
				<details className="text-xs">
					<summary className="cursor-pointer text-muted-foreground">{t("aiElements.inspector.step.toolsAvailable", { count: step.toolCount ?? step.toolNames.length })}</summary>
					<p className="mt-1 break-words font-mono text-caption leading-relaxed">{step.toolNames.join(", ")}</p>
				</details>
			) : null}
			{step.request ? (
				<details className="text-xs">
					<summary className="cursor-pointer text-muted-foreground">{t("aiElements.inspector.step.request")}{step.request.truncated ? t("aiElements.inspector.step.partial") : ""}</summary>
					<pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-2 font-mono text-caption">{step.request.text}</pre>
				</details>
			) : null}
		</li>
	);
}

function ToolRow({ call }: { call: InspectToolCall }) {
	const { t, locale } = useTranslations();
	const status = TOOL_STATUS[call.status];
	return (
		<li className="space-y-1 rounded-xl border bg-card p-3" data-tool-status={call.status}>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="min-w-0 truncate font-medium font-mono text-xs">{call.name}</span>
				<span className="flex items-center gap-2 text-muted-foreground text-xs">
					{call.durationMs !== undefined ? formatMs(call.durationMs, locale) : null}
					<Badge variant={status.variant}>{t(status.label)}</Badge>
				</span>
			</div>
			{call.args ? <p className="break-words font-mono text-caption text-muted-foreground">{call.args}</p> : null}
			{call.summary ? <p className="break-words text-xs">{call.summary}</p> : null}
		</li>
	);
}

const loadedLater = (lessons: NonNullable<RunInspection["lessons"]>, { t }: Translator) => {
	const count = lessons.loaded.reduce((sum, item) => sum + item.refs.length, 0);
	return t(count === 1 ? "aiElements.inspector.lessons.loadedOne" : "aiElements.inspector.lessons.loadedMany", { count });
};

const USED_LABEL = {
	helped: "aiElements.inspector.lessons.used.helped",
	hurt: "aiElements.inspector.lessons.used.hurt",
	applied: "aiElements.inspector.lessons.used.applied",
} as const satisfies Record<string, MessageKey>;

/** Resumo da revisão de lições do run anterior (job em segundo plano), como uma ação deste run. */
export function describeLessonReview(review: NonNullable<NonNullable<RunInspection["lessons"]>["review"]>, { t, tn }: Translator = defaultTranslator): string {
	if (review.status === "skipped") return t("aiElements.inspector.lessons.skipped");
	const parts: string[] = [];
	if (review.added) parts.push(tn("aiElements.inspector.lessons.added", review.added));
	if (review.updated) parts.push(tn("aiElements.inspector.lessons.updated", review.updated));
	if (review.retired) parts.push(tn("aiElements.inspector.lessons.retired", review.retired));
	if (review.counters) parts.push(tn("aiElements.inspector.lessons.counters", review.counters));
	if (review.skillProposal) parts.push(t("aiElements.inspector.lessons.skillProposal"));
	const rejected = review.rejected ? tn("aiElements.inspector.lessons.rejected", review.rejected) : "";
	return t("aiElements.inspector.lessons.review", { parts: parts.length > 0 ? parts.join(", ") : t("aiElements.inspector.lessons.none"), rejected });
}

/** Lições neste run: quantas entraram (e quais), as que o modelo marcou como usadas e a revisão anterior. */
export function LessonsBlock({ lessons }: { lessons: NonNullable<RunInspection["lessons"]> }) {
	const translator = useTranslations();
	const { t } = translator;
	return (
		<div className="space-y-1 rounded-lg bg-muted px-3 py-2 text-xs" data-run-lessons>
			{lessons.injected.length > 0 ? (
				<p>
					{t("aiElements.inspector.lessons.injected", { count: lessons.injected.length, refs: lessons.injected.map((ref) => `[${ref}]`).join(" ") })}
					{lessons.loaded.length > 0 ? t("aiElements.inspector.lessons.afterConnector", { loaded: loadedLater(lessons, translator) }) : ""}
				</p>
			) : null}
			{lessons.used.length > 0 ? <p>{t("aiElements.inspector.lessons.markedUsed", { items: lessons.used.map((item) => `[${item.ref}] ${t(USED_LABEL[item.outcome])}`).join(", ") })}</p> : null}
			{lessons.review ? <p data-run-lessons-review>{describeLessonReview(lessons.review, translator)}</p> : null}
		</div>
	);
}

/** Corpo do inspetor (sem rede): quem busca os dados passa a inspeção pronta. */
export function RunInspectorView({ inspection, onCopy, copied = false }: { inspection: RunInspection; onCopy?: () => void; copied?: boolean }) {
	const translator = useTranslations();
	const { t, locale } = translator;
	const scale = Math.max(1, ...inspection.steps.map((step) => step.estimatedTotal ?? 0));
	const { totals } = inspection;
	return (
		<div className="run-inspector flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
			<dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
				<div>
					<dt className="text-muted-foreground">{t("aiElements.inspector.view.model")}</dt>
					<dd className="truncate">{inspection.model}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">{t("aiElements.inspector.view.steps")}</dt>
					<dd>{totals.steps}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">{t("aiElements.inspector.view.tools")}</dt>
					<dd>
						{totals.toolCalls}
						{totals.failedToolCalls > 0 ? t("aiElements.inspector.view.withFailures", { count: totals.failedToolCalls }) : ""}
					</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">{t("aiElements.inspector.view.inOut")}</dt>
					<dd>
						{formatTokens(totals.promptTokens, locale)} / {formatTokens(totals.completionTokens, locale)}
					</dd>
				</div>
				{totals.costUsd !== undefined ? (
					<div>
						<dt className="text-muted-foreground">{t("aiElements.inspector.view.cost")}</dt>
						<dd>US$ {totals.costUsd.toFixed(4)}</dd>
					</div>
				) : null}
				<div>
					<dt className="text-muted-foreground">{t("aiElements.inspector.view.status")}</dt>
					<dd>{inspection.status}</dd>
				</div>
			</dl>
			{inspection.context ? <p className="rounded-lg bg-muted px-3 py-2 text-xs">{describeContext(inspection.context, translator)}</p> : null}
			{inspection.approvals.filter((approval) => approval.plan).map((approval) => (
				<p className="rounded-lg bg-muted px-3 py-2 text-xs" data-run-plan key={approval.id}>
					{describePlan(approval, translator)}
				</p>
			))}
			{inspection.lessons ? <LessonsBlock lessons={inspection.lessons} /> : null}
			{inspection.hooks ? <HooksBlock hooks={inspection.hooks} /> : null}
			{inspection.errors.length > 0 || inspection.error ? (
				<ul className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-xs">
					{(inspection.errors.length > 0 ? inspection.errors.map((item) => item.message) : [inspection.error!]).map((message, index) => (
						<li className="break-words" key={index}>
							{message}
						</li>
					))}
				</ul>
			) : null}
			<Tabs defaultValue="steps">
				<TabsList>
					<TabsTrigger value="steps">{t("aiElements.inspector.view.steps")}</TabsTrigger>
					<TabsTrigger value="tools">{t("aiElements.inspector.view.callsTab", { count: inspection.toolCalls.length })}</TabsTrigger>
					<TabsTrigger value="approvals">{t("aiElements.inspector.view.approvalsTab", { count: inspection.approvals.length })}</TabsTrigger>
				</TabsList>
				<TabsContent className="space-y-3 pt-3" value="steps">
					<Legend />
					{inspection.steps.length > 0 ? (
						<ol className="space-y-2">
							{inspection.steps.map((step) => (
								<StepCard key={step.decisionIndex} scale={scale} step={step} />
							))}
						</ol>
					) : (
						<p className="text-muted-foreground text-sm">{t("aiElements.inspector.view.noModelCalls")}</p>
					)}
				</TabsContent>
				<TabsContent className="pt-3" value="tools">
					{inspection.toolCalls.length > 0 ? (
						<ol className="space-y-2">
							{inspection.toolCalls.map((call) => (
								<ToolRow call={call} key={call.id} />
							))}
						</ol>
					) : (
						<p className="text-muted-foreground text-sm">{t("aiElements.inspector.view.noTools")}</p>
					)}
				</TabsContent>
				<TabsContent className="pt-3" value="approvals">
					{inspection.approvals.length > 0 ? (
						<ul className="space-y-2">
							{inspection.approvals.map((approval) => (
								<li className="space-y-1 rounded-xl border bg-card p-3" key={approval.id}>
									<div className="flex items-center justify-between gap-2">
										<span className="min-w-0 truncate text-sm">{approval.title}</span>
										<Badge variant={APPROVAL_STATUS[approval.status].variant}>{t(APPROVAL_STATUS[approval.status].label)}</Badge>
									</div>
									{approval.detail ? <p className="break-words text-muted-foreground text-xs">{approval.detail}</p> : null}
								</li>
							))}
						</ul>
					) : (
						<p className="text-muted-foreground text-sm">{t("aiElements.inspector.view.noApprovals")}</p>
					)}
				</TabsContent>
			</Tabs>
			{onCopy ? (
				<Button className="self-start" onClick={onCopy} size="sm" type="button" variant="outline">
					{copied ? t("aiElements.inspector.view.copied") : t("aiElements.inspector.view.copyJson")}
				</Button>
			) : null}
		</div>
	);
}
