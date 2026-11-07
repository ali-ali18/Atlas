"use client";

import { useState } from "react";
import type { MemoryChange, SleepReportView } from "@workspace/shared";
import { useTranslations } from "@/lib/i18n/provider";
import { ListEmpty, ListLoadError, ListLoading } from "./list-status";
import { dismissProposal, type NotebookApi, realNotebookApi, undoChange } from "./notebook-actions";
import { type ChangesState, ReportCard, ReportsList } from "./night-review-view";
import { NotebookSubSection } from "./sub-section";
import { useLoader } from "./use-loader";

const PAGE_SIZE = 7;

type ReportsData = { reports: SleepReportView[]; nextCursor: string | null };

/** Sub-bloco "Revisão da noite": relatórios do dia e do domingo; as mudanças de cada um só carregam quando ele abre. */
export function NightReviewBlock({ botId, api = realNotebookApi, defaultOpen = false }: { botId: string; api?: NotebookApi; defaultOpen?: boolean }) {
	const translator = useTranslations();
	return (
		<NotebookSubSection defaultOpen={defaultOpen} id="review" title={translator.t("notebook.review.title")}>
			<ReviewBody api={api} botId={botId} />
		</NotebookSubSection>
	);
}

function ReviewBody({ botId, api }: { botId: string; api: NotebookApi }) {
	const { t } = useTranslations();
	const [loadingMore, setLoadingMore] = useState(false);
	const { state, reload, setData } = useLoader<ReportsData>(() => api.listSleepReports({ botId, limit: PAGE_SIZE }), [botId, api]);

	async function loadMore(cursor: string) {
		setLoadingMore(true);
		try {
			const page = await api.listSleepReports({ botId, limit: PAGE_SIZE, cursor });
			setData((data) => ({ reports: [...data.reports, ...page.reports.filter((report) => !data.reports.some((known) => known.id === report.id))], nextCursor: page.nextCursor }));
		} catch {
			// a lista que já está na tela continua valendo; "Ver relatórios mais antigos" segue disponível
		} finally {
			setLoadingMore(false);
		}
	}

	if (state.status === "loading") return <ListLoading />;
	if (state.status === "error") return <ListLoadError onRetry={reload} />;
	const { reports, nextCursor } = state.data;
	if (reports.length === 0) return <ListEmpty>{t("notebook.review.empty")}</ListEmpty>;
	return (
		<ReportsList hasMore={nextCursor !== null} loadingMore={loadingMore} onLoadMore={() => nextCursor && void loadMore(nextCursor)}>
			{reports.map((report, index) => (
				<ReportItem
					api={api}
					botId={botId}
					defaultOpen={index === 0}
					key={report.id}
					onReport={(next) => setData((data) => ({ ...data, reports: data.reports.map((item) => (item.id === next.id ? next : item)) }))}
					report={report}
				/>
			))}
		</ReportsList>
	);
}

/** Estado de um relatório: aberto/fechado, mudanças (carregadas ao abrir) e os pedidos de desfazer e dispensar. */
function ReportItem({ report, botId, api, defaultOpen, onReport }: { report: SleepReportView; botId: string; api: NotebookApi; defaultOpen: boolean; onReport: (report: SleepReportView) => void }) {
	const translator = useTranslations();
	const [open, setOpen] = useState(defaultOpen);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	return (
		<ReportItemBody
			api={api}
			botId={botId}
			busyId={busyId}
			error={error}
			onDismiss={async (proposalId) => {
				setBusyId(proposalId);
				setError(null);
				const result = await dismissProposal(api, report.id, proposalId, translator);
				setBusyId(null);
				if (result.ok) onReport(result.value);
				else setError(result.message);
			}}
			onOpenChange={setOpen}
			open={open}
			report={report}
			setBusyId={setBusyId}
			setError={setError}
		/>
	);
}

function ReportItemBody({
	report,
	botId,
	api,
	open,
	busyId,
	error,
	onOpenChange,
	onDismiss,
	setBusyId,
	setError,
}: {
	report: SleepReportView;
	botId: string;
	api: NotebookApi;
	open: boolean;
	busyId: string | null;
	error: string | null;
	onOpenChange: (open: boolean) => void;
	onDismiss: (proposalId: string) => void;
	setBusyId: (id: string | null) => void;
	setError: (message: string | null) => void;
}) {
	const translator = useTranslations();
	// Só pede as mudanças quando o relatório está aberto; fechado, `load` devolve vazio sem ir ao servidor.
	const { state, reload, setData } = useLoader<readonly MemoryChange[]>(async () => (open ? (await api.listSleepChanges({ botId, reportId: report.id })).changes : []), [botId, report.id, open, api]);
	const changes: ChangesState = state.status === "ready" ? { status: "ready", changes: state.data } : state;

	async function undo(change: MemoryChange) {
		setBusyId(change.id);
		setError(null);
		const result = await undoChange(api, change.id, translator);
		setBusyId(null);
		if (result.ok) {
			setData((list) => list.map((item) => (item.id === change.id ? { ...item, undoneAt: result.value.createdAt } : item)));
			return;
		}
		setError(result.message);
		// "Já foi desfeito" ou "mudou depois": a lista pode estar velha, recarrega o estado real.
		reload();
	}

	return <ReportCard busyId={busyId} changes={changes} error={error} onDismiss={onDismiss} onOpenChange={onOpenChange} onRetryChanges={reload} onUndo={undo} open={open} report={report} />;
}
