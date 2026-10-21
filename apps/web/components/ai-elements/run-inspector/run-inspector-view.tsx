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

/** Rótulos e tons neutros (opacidade do texto) de cada categoria da barra empilhada. */
export const INSPECT_CATEGORY_META: Record<InspectCategory, { label: string; tone: string }> = {
	system: { label: "Instruções", tone: "bg-foreground/80" },
	tools: { label: "Ferramentas", tone: "bg-foreground/60" },
	history: { label: "Histórico", tone: "bg-foreground/45" },
	toolResults: { label: "Resultados", tone: "bg-foreground/30" },
	notes: { label: "Notas e memória", tone: "bg-foreground/20" },
	turn: { label: "Turno atual", tone: "bg-foreground/10" },
};

const TRANSCRIPT_REASONS: Record<string, string> = {
	no_watermark: "sem marca d'água",
	corrupt: "gravação corrompida",
	compact_mode: "modo compacto",
	seed_unavailable: "aprovação sem origem",
	disabled: "desligado",
	group: "conversa em grupo",
	origin: "origem automática",
	no_conversation: "sem conversa",
};

const TOOL_STATUS: Record<InspectToolCall["status"], { label: string; variant: "secondary" | "destructive" | "outline" }> = {
	ok: { label: "Concluída", variant: "secondary" },
	failed: { label: "Falhou", variant: "destructive" },
	running: { label: "Em andamento", variant: "outline" },
	uncertain: { label: "Incerta", variant: "outline" },
};

const APPROVAL_STATUS: Record<InspectApproval["status"], { label: string; variant: "secondary" | "destructive" | "outline" }> = {
	pending: { label: "Pendente", variant: "outline" },
	approved: { label: "Aprovado", variant: "secondary" },
	rejected: { label: "Recusado", variant: "outline" },
	failed: { label: "Falhou", variant: "destructive" },
};

export function formatTokens(value: number): string {
	if (value >= 10_000) return `${Math.round(value / 1000)}k`;
	if (value >= 1000) return `${(value / 1000).toFixed(1).replace(".", ",")}k`;
	return String(Math.round(value));
}

function formatMs(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1).replace(".", ",")} s` : `${Math.round(ms)} ms`;
}

export function describeAction(action: InspectAction): string {
	switch (action.kind) {
		case "collapsed":
			return `Limpeza: ${action.count ?? 0} ${action.count === 1 ? "grupo colapsado" : "grupos colapsados"}`;
		case "trimmed":
			return `Cortou ${action.count ?? 0} ${action.count === 1 ? "mensagem" : "mensagens"}`;
		case "summary":
			return action.before !== undefined && action.after !== undefined ? `Resumo aplicado (${formatTokens(action.before)} para ${formatTokens(action.after)})` : "Resumo aplicado";
		case "summary_failed":
			return "Resumo falhou";
		case "compaction":
			return action.before !== undefined && action.after !== undefined ? `Compactação (${formatTokens(action.before)} para ${formatTokens(action.after)})` : "Compactação";
		case "compact":
			return action.before !== undefined && action.after !== undefined ? `Conversa compactada (${formatTokens(action.before)} para ${formatTokens(action.after)})` : "Conversa compactada";
		case "guard":
			return action.detail === "hard" ? "Proteção da janela: forte" : "Proteção da janela: leve";
	}
}

export function describeContext(context: NonNullable<RunInspection["context"]>): string {
	const prior = context.priorMessages !== undefined ? ` (${context.priorMessages} mensagens)` : "";
	switch (context.mode) {
		case "carried":
			return `Transcrição carregada${prior}`;
		case "seed":
			return `Transcrição carregada pela aprovação${prior}`;
		case "fallback":
			return `Histórico só de texto: ${TRANSCRIPT_REASONS[context.reason ?? ""] ?? context.reason ?? "motivo não informado"}`;
		case "first_turn":
			return "Primeira mensagem da conversa";
		case "off":
			return `Sem transcrição: ${TRANSCRIPT_REASONS[context.reason ?? ""] ?? context.reason ?? "não se aplica"}`;
	}
}

export function TokenBar({ tokens, scale }: { tokens: Record<InspectCategory, number>; scale: number }) {
	const total = INSPECT_CATEGORIES.reduce((sum, key) => sum + tokens[key], 0);
	const width = scale > 0 ? Math.max(4, Math.round((total / scale) * 100)) : 100;
	return (
		<div
			aria-label={INSPECT_CATEGORIES.map((key) => `${INSPECT_CATEGORY_META[key].label} ${tokens[key]}`).join(", ")}
			className="flex h-2.5 overflow-hidden rounded-full bg-muted"
			role="img"
			style={{ width: `${width}%` }}
		>
			{INSPECT_CATEGORIES.map((key) =>
				tokens[key] > 0 ? <span className={cn("h-full", INSPECT_CATEGORY_META[key].tone)} key={key} style={{ width: `${(tokens[key] / Math.max(1, total)) * 100}%` }} title={`${INSPECT_CATEGORY_META[key].label}: ~${tokens[key]}`} /> : null,
			)}
		</div>
	);
}

function Legend() {
	return (
		<ul className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground text-xs">
			{INSPECT_CATEGORIES.map((key) => (
				<li className="flex items-center gap-1.5" key={key}>
					<span aria-hidden className={cn("size-2 rounded-full", INSPECT_CATEGORY_META[key].tone)} />
					{INSPECT_CATEGORY_META[key].label}
				</li>
			))}
		</ul>
	);
}

function StepCard({ step, scale }: { step: InspectStepView; scale: number }) {
	const facts = [
		step.provider,
		step.model ?? step.requestedModel,
		step.durationMs !== undefined ? formatMs(step.durationMs) : undefined,
		step.finishReason ? `fim: ${step.finishReason}` : undefined,
	].filter(Boolean);
	return (
		<li className="space-y-2 rounded-xl border bg-card p-3" data-step={step.decisionIndex}>
			<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
				<span className="font-medium text-sm">Passo {step.decisionIndex + 1}</span>
				<span className="min-w-0 truncate text-muted-foreground text-xs">{facts.join(" · ")}</span>
			</div>
			{step.tokens ? <TokenBar scale={scale} tokens={step.tokens} /> : <p className="text-muted-foreground text-xs">Sem detalhamento (passo anterior ao inspetor).</p>}
			<p className="text-muted-foreground text-xs">
				{step.estimatedTotal !== undefined ? `~${formatTokens(step.estimatedTotal)} estimados` : null}
				{step.promptTokens !== undefined ? `${step.estimatedTotal !== undefined ? " · " : ""}entrada ${formatTokens(step.promptTokens)}` : null}
				{step.completionTokens !== undefined ? ` · saída ${formatTokens(step.completionTokens)}` : null}
				{step.cacheReadTokens !== undefined ? ` · cache lido ${formatTokens(step.cacheReadTokens)}` : null}
				{step.cacheWriteTokens !== undefined ? ` · cache gravado ${formatTokens(step.cacheWriteTokens)}` : null}
				{step.contextLength !== undefined && step.estimatedTotal !== undefined ? ` · ${Math.round((step.estimatedTotal / step.contextLength) * 100)}% da janela` : null}
				{step.retries ? ` · ${step.retries} ${step.retries === 1 ? "nova tentativa" : "novas tentativas"}${step.retryReasons?.length ? ` (${step.retryReasons.join(", ")})` : ""}` : null}
			</p>
			{step.actions.length > 0 ? (
				<ul className="flex flex-wrap gap-1.5">
					{step.actions.map((action, index) => (
						<li key={`${action.kind}-${index}`}>
							<Badge variant={action.kind === "summary_failed" ? "destructive" : "outline"}>{describeAction(action)}</Badge>
						</li>
					))}
				</ul>
			) : null}
			{step.toolNames && step.toolNames.length > 0 ? (
				<details className="text-xs">
					<summary className="cursor-pointer text-muted-foreground">{step.toolCount ?? step.toolNames.length} ferramentas disponíveis</summary>
					<p className="mt-1 break-words font-mono text-[11px] leading-relaxed">{step.toolNames.join(", ")}</p>
				</details>
			) : null}
			{step.request ? (
				<details className="text-xs">
					<summary className="cursor-pointer text-muted-foreground">Pedido enviado (redigido){step.request.truncated ? ", parcial" : ""}</summary>
					<pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-2 font-mono text-[11px]">{step.request.text}</pre>
				</details>
			) : null}
		</li>
	);
}

function ToolRow({ call }: { call: InspectToolCall }) {
	const status = TOOL_STATUS[call.status];
	return (
		<li className="space-y-1 rounded-xl border bg-card p-3" data-tool-status={call.status}>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="min-w-0 truncate font-medium font-mono text-xs">{call.name}</span>
				<span className="flex items-center gap-2 text-muted-foreground text-xs">
					{call.durationMs !== undefined ? formatMs(call.durationMs) : null}
					<Badge variant={status.variant}>{status.label}</Badge>
				</span>
			</div>
			{call.args ? <p className="break-words font-mono text-[11px] text-muted-foreground">{call.args}</p> : null}
			{call.summary ? <p className="break-words text-xs">{call.summary}</p> : null}
		</li>
	);
}

/** Corpo do inspetor (sem rede): quem busca os dados passa a inspeção pronta. */
export function RunInspectorView({ inspection, onCopy, copied = false }: { inspection: RunInspection; onCopy?: () => void; copied?: boolean }) {
	const scale = Math.max(1, ...inspection.steps.map((step) => step.estimatedTotal ?? 0));
	const { totals } = inspection;
	return (
		<div className="run-inspector flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
			<dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
				<div>
					<dt className="text-muted-foreground">Modelo</dt>
					<dd className="truncate">{inspection.model}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">Passos</dt>
					<dd>{totals.steps}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">Ferramentas</dt>
					<dd>
						{totals.toolCalls}
						{totals.failedToolCalls > 0 ? ` (${totals.failedToolCalls} com falha)` : ""}
					</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">Entrada / saída</dt>
					<dd>
						{formatTokens(totals.promptTokens)} / {formatTokens(totals.completionTokens)}
					</dd>
				</div>
				{totals.costUsd !== undefined ? (
					<div>
						<dt className="text-muted-foreground">Custo</dt>
						<dd>US$ {totals.costUsd.toFixed(4)}</dd>
					</div>
				) : null}
				<div>
					<dt className="text-muted-foreground">Situação</dt>
					<dd>{inspection.status}</dd>
				</div>
			</dl>
			{inspection.context ? <p className="rounded-lg bg-muted px-3 py-2 text-xs">{describeContext(inspection.context)}</p> : null}
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
					<TabsTrigger value="steps">Passos</TabsTrigger>
					<TabsTrigger value="tools">Chamadas ({inspection.toolCalls.length})</TabsTrigger>
					<TabsTrigger value="approvals">Aprovações ({inspection.approvals.length})</TabsTrigger>
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
						<p className="text-muted-foreground text-sm">Nenhuma chamada ao modelo registrada.</p>
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
						<p className="text-muted-foreground text-sm">Nenhuma ferramenta usada.</p>
					)}
				</TabsContent>
				<TabsContent className="pt-3" value="approvals">
					{inspection.approvals.length > 0 ? (
						<ul className="space-y-2">
							{inspection.approvals.map((approval) => (
								<li className="space-y-1 rounded-xl border bg-card p-3" key={approval.id}>
									<div className="flex items-center justify-between gap-2">
										<span className="min-w-0 truncate text-sm">{approval.title}</span>
										<Badge variant={APPROVAL_STATUS[approval.status].variant}>{APPROVAL_STATUS[approval.status].label}</Badge>
									</div>
									{approval.detail ? <p className="break-words text-muted-foreground text-xs">{approval.detail}</p> : null}
								</li>
							))}
						</ul>
					) : (
						<p className="text-muted-foreground text-sm">Nenhuma aprovação neste run.</p>
					)}
				</TabsContent>
			</Tabs>
			{onCopy ? (
				<Button className="self-start" onClick={onCopy} size="sm" type="button" variant="outline">
					{copied ? "Copiado" : "Copiar JSON"}
				</Button>
			) : null}
		</div>
	);
}
