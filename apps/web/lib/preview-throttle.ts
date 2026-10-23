/**
 * Prévia da última mensagem na lista de conversas. Atualizar a lista re-renderiza o app inteiro, então durante
 * o stream (um evento por token) a prévia sai no máximo uma vez por intervalo, sempre com o texto mais novo;
 * fora do stream (fim do run, troca de conversa, mensagem nova) sai na hora.
 */
export type PreviewReporter = {
	/** `key` identifica a conversa; `streaming` = run em andamento. */
	update: (key: string, botId: string, text: string, streaming: boolean) => void;
	cancel: () => void;
};

export const PREVIEW_STREAM_INTERVAL_MS = 1000;

export function createPreviewReporter({
	report,
	intervalMs = PREVIEW_STREAM_INTERVAL_MS,
	now = () => Date.now(),
	setTimer = (run, ms) => setTimeout(run, ms),
	clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}: {
	report: (botId: string, text: string) => void;
	intervalMs?: number;
	now?: () => number;
	setTimer?: (run: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}): PreviewReporter {
	let last: { key: string; text: string; at: number } | null = null;
	let pending: { key: string; botId: string; text: string } | null = null;
	let timer: unknown = null;

	const stopTimer = () => {
		if (timer !== null) clearTimer(timer);
		timer = null;
	};
	const emit = (key: string, botId: string, text: string) => {
		pending = null;
		stopTimer();
		last = { key, text, at: now() };
		report(botId, text);
	};

	return {
		update(key, botId, text, streaming) {
			if (last?.key === key && last.text === text) {
				pending = null;
				stopTimer();
				return;
			}
			if (!streaming || !last || last.key !== key || now() - last.at >= intervalMs) {
				emit(key, botId, text);
				return;
			}
			pending = { key, botId, text };
			if (timer !== null) return;
			timer = setTimer(() => {
				timer = null;
				if (pending) emit(pending.key, pending.botId, pending.text);
			}, Math.max(0, last.at + intervalMs - now()));
		},
		cancel() {
			pending = null;
			stopTimer();
		},
	};
}
