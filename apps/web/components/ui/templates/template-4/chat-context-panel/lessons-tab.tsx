"use client";

import { RefreshCwIcon } from "lucide-react";
import type { LessonView } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { ButtonGroup } from "@workspace/ui/components/button-group";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useBotLessons } from "@/hooks/use-bot-lessons";
import { LessonsSection } from "./lessons-section";
import { groupLessons } from "./lessons-tab-helpers";
import { SectionAction } from "./memory-section";

export const LESSONS_EMPTY = "O bot ainda não aprendeu nenhuma lição. Quando você o corrigir ou uma ação falhar e depois der certo, o que ele aprender aparece aqui.";

/** Corpo da aba (apresentação pura): cabeçalho com ações, grupos por escopo e o estado vazio. */
export function LessonsView({
	lessons,
	names = {},
	now = new Date(),
	error,
	busy,
	onRefresh,
	onEdit,
	onRemove,
	onRestore,
	evidenceOpen,
}: {
	lessons: LessonView[];
	names?: Record<string, string>;
	now?: Date;
	error?: string | null;
	busy?: boolean;
	onRefresh?: () => void;
	onEdit: (lessonId: string, content: string) => Promise<string | null>;
	onRemove: (lessonId: string) => Promise<string | null>;
	onRestore: (lessonId: string) => Promise<string | null>;
	evidenceOpen?: boolean;
}) {
	const groups = groupLessons(lessons, names);
	return (
		<div className="flex min-w-0 flex-col gap-6" data-lessons-tab>
			<div className="flex items-center justify-between gap-2">
				<div className="flex min-w-0 flex-col">
					<h3 className="font-medium text-muted-foreground text-xs">Lições aprendidas</h3>
					<p className="text-muted-foreground text-xs">O que este bot aprendeu com o uso e aplica nas próximas conversas</p>
				</div>
				<ButtonGroup>
					<SectionAction disabled={busy} icon={RefreshCwIcon} label="Atualizar" onClick={onRefresh} />
				</ButtonGroup>
			</div>
			{error ? (
				<p className="text-destructive text-xs leading-relaxed" role="alert">
					{error}
				</p>
			) : null}
			{groups.length === 0 ? (
				<p className="px-1 py-3 text-center text-muted-foreground text-xs leading-relaxed" data-lessons-empty>
					{LESSONS_EMPTY}
				</p>
			) : (
				groups.map((group) => <LessonsSection evidenceOpen={evidenceOpen} group={group} key={group.id} now={now} onEdit={onEdit} onRemove={onRemove} onRestore={onRestore} />)
			)}
		</div>
	);
}

/** Aba Lições: o playbook deste bot, agrupado por escopo, com editar, apagar e restaurar a versão anterior. */
export function LessonsTab({ botId, active }: { botId: string; active: boolean }) {
	const state = useBotLessons(botId, active);

	if (state.loading && state.lessons.length === 0) {
		return (
			<div aria-busy="true" aria-label="Carregando as lições" className="flex flex-col gap-3" role="status">
				<Skeleton className="h-5 w-28" />
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-16 w-full" />
			</div>
		);
	}

	if (state.error && state.lessons.length === 0) {
		return (
			<div className="flex flex-col items-center gap-3 py-8 text-center" role="alert">
				<p className="text-muted-foreground text-xs leading-relaxed">{state.error}</p>
				<Button onClick={() => void state.refresh()} size="sm" variant="outline">
					Tentar de novo
				</Button>
			</div>
		);
	}

	return <LessonsView error={state.error} lessons={state.lessons} names={state.names} onEdit={state.edit} onRefresh={() => void state.refresh()} onRemove={state.remove} onRestore={state.restore} />;
}
