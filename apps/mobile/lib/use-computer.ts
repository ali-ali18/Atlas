// Estado da tela do Computador: acha a sessão da VM do bot, pede o link da tela ao vivo e o RENOVA (aos 8 min, que o
// token vale 10, e quando a conexão cai). O link vive só neste estado do React: nunca em log, cache nem disco.
import * as React from "react";
import { ComputerApiError, computerErrorText, getComputerSession, getViewerLink, startComputer } from "./computer-api";
import { canRenewAfterDrop, isLinkExpired, renewDelayMs, RENEW_RETRY_MS } from "./computer-link";
import type { ComputerStatus } from "@/components/computer/computer-view";
import type { ApiFetch } from "./home-sync";

/** Computador ligando: confere de novo a cada 3 s, até ~1 min. */
const STARTING_POLL_MS = 3_000;
const STARTING_POLL_MAX = 20;

export type UseComputer = {
	status: ComputerStatus;
	/** Endereço absoluto da tela ao vivo (com token): só para a WebView, nunca para log. */
	uri: string | null;
	/** Muda a cada link novo: força a WebView a recarregar mesmo se a URL se repetir. */
	linkKey: number;
	sessionId: string | null;
	/** Frase amigável do erro (status "error"). */
	error: string | null;
	/** Tentar de novo do começo. */
	retry: () => void;
	/** Liga o computador (status "off") e abre a tela. */
	start: () => void;
	/** A WebView avisou que a conexão caiu: pede link novo (com intervalo mínimo entre pedidos). */
	reportDrop: () => void;
};

type LinkState = { uri: string; issuedAt: number; key: number };

export function useComputer({ apiFetch, serverUrl, conversationId }: { apiFetch: ApiFetch; serverUrl: string | null; conversationId: string | null }): UseComputer {
	const [status, setStatus] = React.useState<ComputerStatus>("loading");
	const [link, setLink] = React.useState<LinkState | null>(null);
	const [sessionId, setSessionId] = React.useState<string | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	// `n` muda a cada "de novo"/"ligar"; `start` diz se esta rodada liga o computador antes de abrir.
	const [round, setRound] = React.useState({ n: 0, start: false });
	const apiRef = React.useRef({ apiFetch, serverUrl });
	apiRef.current = { apiFetch, serverUrl };
	const renew = React.useRef<(() => void) | null>(null);
	const lastRenewAt = React.useRef(0);
	const linkRef = React.useRef<LinkState | null>(null);
	linkRef.current = link;

	React.useEffect(() => {
		let alive = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let keyCounter = 0;
		const fail = (reason: unknown) => {
			if (!alive) return;
			setLink(null);
			setError(computerErrorText(reason));
			setStatus("error");
		};
		const off = () => {
			if (!alive) return;
			setLink(null);
			setSessionId(null);
			setStatus("off");
		};
		const schedule = (ms: number, run: () => void) => {
			clearTimeout(timer);
			timer = setTimeout(run, ms);
		};
		const fetchLink = async (id: string): Promise<string> => {
			const { apiFetch: api, serverUrl: base } = apiRef.current;
			if (!base) throw new ComputerApiError("bad-link");
			return getViewerLink(api, base, id);
		};
		// Renova só o link (a WebView recarrega com ele); falha passageira tenta de novo e só derruba a tela depois de vencer.
		const renewLink = async (id: string) => {
			clearTimeout(timer);
			lastRenewAt.current = Date.now();
			try {
				const uri = await fetchLink(id);
				if (!alive) return;
				const next = { uri, issuedAt: Date.now(), key: ++keyCounter };
				linkRef.current = next;
				setLink(next);
				schedule(renewDelayMs(next.issuedAt, Date.now()), () => void renewLink(id));
			} catch (reason) {
				if (!alive) return;
				const gone = reason instanceof ComputerApiError && (reason.kind === "not-found" || reason.kind === "unauthorized" || reason.kind === "viewer-unavailable");
				const current = linkRef.current;
				if (gone || !current || isLinkExpired(current.issuedAt, Date.now())) return fail(reason);
				schedule(RENEW_RETRY_MS, () => void renewLink(id));
			}
		};
		const open = async (id: string) => {
			renew.current = () => void renewLink(id);
			await renewLink(id);
			if (alive && linkRef.current) {
				setSessionId(id);
				setError(null);
				setStatus("ready");
			}
		};
		const load = async (startFirst: boolean) => {
			setStatus("loading");
			setError(null);
			if (!conversationId) return off();
			try {
				let session = startFirst ? await startComputer(apiRef.current.apiFetch, conversationId) : await getComputerSession(apiRef.current.apiFetch, conversationId);
				for (let polls = 0; alive && session && session.status === "starting"; polls++) {
					if (polls >= STARTING_POLL_MAX) throw new ComputerApiError("unavailable");
					await new Promise((resolve) => setTimeout(resolve, STARTING_POLL_MS));
					if (!alive) return;
					session = await getComputerSession(apiRef.current.apiFetch, conversationId);
				}
				if (!alive) return;
				if (!session || session.status === "stopped") return off();
				if (session.status === "error") throw new ComputerApiError("unavailable");
				await open(session.sessionId);
			} catch (reason) {
				fail(reason);
			}
		};
		void load(round.start);
		return () => {
			alive = false;
			clearTimeout(timer);
			renew.current = null;
			// O link sai da memória junto com a tela.
			linkRef.current = null;
		};
	}, [conversationId, round]);

	const retry = React.useCallback(() => setRound((r) => ({ n: r.n + 1, start: false })), []);
	const start = React.useCallback(() => setRound((r) => ({ n: r.n + 1, start: true })), []);
	const reportDrop = React.useCallback(() => {
		if (!canRenewAfterDrop(lastRenewAt.current, Date.now())) return;
		renew.current?.();
	}, []);

	return { status, uri: link?.uri ?? null, linkKey: link?.key ?? 0, sessionId, error, retry, start, reportDrop };
}
