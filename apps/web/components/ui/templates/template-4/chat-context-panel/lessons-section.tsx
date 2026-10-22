"use client";

import { ChevronDownIcon, HistoryIcon, MoreHorizontalIcon, PencilIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import type { LessonRule, LessonView } from "@workspace/shared";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import { LessonRuleForm } from "./lesson-rule-form";
import { MemoryTextForm } from "./memory-section";
import { memoryRelativeDate } from "./memory-tab-helpers";
import { describeLessonRule, lessonCounters, lessonEvidenceText, lessonOriginLabel, toolOptionsForLesson, type LessonGroup, type LessonToolOption } from "./lessons-tab-helpers";

type LessonActions = {
	onEdit: (lessonId: string, content: string) => Promise<string | null>;
	onRemove: (lessonId: string) => Promise<string | null>;
	onRestore: (lessonId: string) => Promise<string | null>;
	/** Liga, troca (regra) ou tira (null) a regra que o bot passa a cumprir. */
	onSetRule?: (lessonId: string, rule: LessonRule | null) => Promise<string | null>;
	/** Ferramentas dos conectores do bot, para o seletor da regra. */
	tools?: readonly LessonToolOption[];
};

function LessonItem({ lesson, now, onEdit, onRemove, onRestore, onSetRule, tools = [], evidenceOpen }: LessonActions & { lesson: LessonView; now: Date; evidenceOpen?: boolean }) {
	const [editing, setEditing] = useState(false);
	const [ruleOpen, setRuleOpen] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const evidence = lessonEvidenceText(lesson.evidence);
	const counters = lessonCounters(lesson);

	if (editing) {
		return (
			<li className="rounded-2xl border border-border bg-card p-3" data-lesson-item={lesson.id}>
				<MemoryTextForm initial={lesson.content} label="Editar lição" onCancel={() => setEditing(false)} onSubmit={(content) => onEdit(lesson.id, content)} />
			</li>
		);
	}

	return (
		<li className="flex min-w-0 items-start gap-2 rounded-2xl border border-border bg-card py-2.5 pr-1.5 pl-3" data-lesson-item={lesson.id}>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<p className="break-words text-sm leading-relaxed whitespace-pre-wrap">{lesson.content}</p>
				<p className="text-muted-foreground text-xs">
					{lessonOriginLabel(lesson.origin)} · {memoryRelativeDate(lesson.updatedAt, now)}
					{lesson.version > 1 ? ` · versão ${lesson.version}` : ""}
				</p>
				{counters ? <p className="text-muted-foreground/80 text-xs">{counters}</p> : null}
				{lesson.rule ? (
					<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" data-lesson-rule={lesson.rule.kind}>
						<Badge data-lesson-rule-badge variant="secondary">
							<ShieldCheckIcon aria-hidden />
							Regra ativa
						</Badge>
						<span className="min-w-0 break-words text-muted-foreground text-xs">{describeLessonRule(lesson.rule)}</span>
					</div>
				) : null}
				{ruleOpen && onSetRule ? (
					<div className="mt-1 rounded-xl bg-muted/50 p-3">
						<LessonRuleForm
							initial={lesson.rule}
							lessonId={lesson.id}
							onCancel={() => setRuleOpen(false)}
							onRemove={lesson.rule ? () => onSetRule(lesson.id, null) : undefined}
							onSave={(rule) => onSetRule(lesson.id, rule)}
							tools={toolOptionsForLesson(lesson, tools)}
						/>
					</div>
				) : null}
				{evidence ? (
					<Collapsible defaultOpen={evidenceOpen}>
						<CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground">
							<ChevronDownIcon aria-hidden className="size-3.5" />
							Por que o bot aprendeu isto
						</CollapsibleTrigger>
						<CollapsibleContent>
							<div className="mt-1 flex flex-col gap-0.5 rounded-xl bg-muted/50 px-3 py-2" data-lesson-evidence>
								<p className="text-muted-foreground text-xs">{evidence.kind}</p>
								<p className="break-words text-xs leading-relaxed whitespace-pre-wrap">“{evidence.quote}”</p>
							</div>
						</CollapsibleContent>
					</Collapsible>
				) : null}
				{actionError ? (
					<p className="text-destructive text-xs" role="alert">
						{actionError}
					</p>
				) : null}
			</div>
			<DropdownMenu>
				<DropdownMenuTrigger render={<Button aria-label="Ações da lição" className="shrink-0 text-muted-foreground" size="icon-sm" variant="ghost" />}>
					<MoreHorizontalIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={() => setEditing(true)}>
						<PencilIcon />
						Editar
					</DropdownMenuItem>
					{onSetRule ? (
						<DropdownMenuItem onClick={() => setRuleOpen(true)}>
							<ShieldCheckIcon />
							{lesson.rule ? "Editar regra" : "Definir regra"}
						</DropdownMenuItem>
					) : null}
					{lesson.canRestore ? (
						<DropdownMenuItem
							onClick={async () => {
								setActionError(null);
								setActionError(await onRestore(lesson.id));
							}}
						>
							<HistoryIcon />
							Restaurar versão anterior
						</DropdownMenuItem>
					) : null}
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onClick={async () => {
							setActionError(null);
							setActionError(await onRemove(lesson.id));
						}}
						variant="destructive"
					>
						<Trash2Icon />
						Apagar
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</li>
	);
}

/** Um grupo de escopo da aba Lições (geral do bot, um conector ou uma ferramenta). */
export function LessonsSection({ group, now, onEdit, onRemove, onRestore, onSetRule, tools, evidenceOpen }: LessonActions & { group: LessonGroup; now: Date; evidenceOpen?: boolean }) {
	const headingId = `lessons-${group.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
	return (
		<section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2" data-lessons-section={group.id}>
			<div className="flex min-w-0 flex-col">
				<h3 className="font-medium text-muted-foreground text-xs" id={headingId}>
					{group.title}
				</h3>
				{group.note ? <p className="text-muted-foreground text-xs">{group.note}</p> : null}
			</div>
			<ul className="m-0 flex list-none flex-col gap-2 p-0">
				{group.lessons.map((lesson) => (
					<LessonItem evidenceOpen={evidenceOpen} key={lesson.id} lesson={lesson} now={now} onEdit={onEdit} onRemove={onRemove} onRestore={onRestore} onSetRule={onSetRule} tools={tools} />
				))}
			</ul>
		</section>
	);
}
