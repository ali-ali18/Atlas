import * as React from "react";
import { fetch as expoFetch } from "expo/fetch";
import { createApiFetch } from "@/lib/api-fetch";
import { createRunStreamOpener } from "@/lib/chat-open";
import type { OpenStream } from "@/lib/chat-stream";
import { createAtlasAuthClient, type AtlasAuthClient } from "@/lib/auth-client";
import { canMarkSynced, phaseOf, type AccessPhase } from "@/lib/auth-flow";
import { clearHomeCacheLogged } from "@/lib/home-storage";
import { clearAllBotRuns } from "@/lib/run-store";
import { clearServerUrl, loadServerUrl, saveServerUrl } from "@/lib/server-store";

export type AtlasSession = {
	phase: AccessPhase;
	serverUrl: string | null;
	client: AtlasAuthClient | null;
	email: string | null;
	/** Nome e foto da conta (a foto vem do Google, quando há). */
	name: string | null;
	image: string | null;
	/** Verdadeiro uma vez, logo depois de entrar nesta execução do app (para o avatar feliz). */
	justSignedIn: boolean;
	/** O carregamento (Sincronizando) já rodou nesta sessão: a home pode abrir. */
	synced: boolean;
	/** Marca o carregamento como feito. Não faz nada se a sessão já caiu ou se há uma saída em andamento. */
	markSynced: () => boolean;
	/** Avisa quando o usuário pede para sair ou trocar de servidor (antes de o cache ser apagado). Devolve o cancelamento. */
	onSignOut: (listener: () => void) => () => void;
	markSignedIn: () => void;
	consumeJustSignedIn: () => void;
	connectServer: (url: string) => Promise<void>;
	/** Encerra a sessão (mesmo sem rede: o app esquece o cookie) e fica no mesmo servidor. */
	signOut: () => Promise<void>;
	/** Encerra a sessão e esquece o servidor. */
	changeServer: () => Promise<void>;
	apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
	/** Abre o stream SSE de um run (`expo/fetch`, com XHR como plano B). */
	openRunStream: (runId: string) => OpenStream;
};

const Context = React.createContext<AtlasSession | null>(null);

export function useAtlasSession(): AtlasSession {
	const value = React.useContext(Context);
	if (!value) throw new Error("useAtlasSession fora do AtlasSessionProvider");
	return value;
}

/** Guarda o endereço do servidor e cria o cliente de autenticação dele. */
export function AtlasSessionProvider({ children }: { children: React.ReactNode }) {
	const [loaded, setLoaded] = React.useState(false);
	const [serverUrl, setServerUrl] = React.useState<string | null>(null);
	const [justSignedIn, setJustSignedIn] = React.useState(false);
	const [synced, setSynced] = React.useState(false);

	React.useEffect(() => {
		void loadServerUrl().then((saved) => {
			setServerUrl(saved);
			setLoaded(true);
		});
	}, []);

	const client = React.useMemo(() => (serverUrl ? createAtlasAuthClient(serverUrl) : null), [serverUrl]);

	const connectServer = React.useCallback(async (url: string) => {
		await saveServerUrl(url);
		setServerUrl(url);
	}, []);

	const forgetServer = React.useCallback(async () => {
		await clearServerUrl();
		setServerUrl(null);
	}, []);

	// O hook de sessão só existe para um cliente real. Um componente à parte o lê e avisa aqui, assim a árvore
	// de telas (filhos) não remonta quando o servidor é conectado ou esquecido.
	const [probe, setProbe] = React.useState<ProbeState | null>(null);
	const reading = client && serverUrl && probe?.url === serverUrl ? probe : null;
	const email = reading?.email ?? null;
	const name = reading?.name ?? null;
	const image = reading?.image ?? null;
	const pending = Boolean(client) && (reading ? reading.pending : true);
	const hasSession = email !== null;

	// Saída em andamento: segura qualquer `markSynced` de um carregamento antigo até a próxima sessão de pé.
	const signingOut = React.useRef(false);
	const signOutListeners = React.useRef(new Set<() => void>());
	const onSignOut = React.useCallback((listener: () => void) => {
		signOutListeners.current.add(listener);
		return () => void signOutListeners.current.delete(listener);
	}, []);

	const signOut = React.useCallback(async () => {
		signingOut.current = true;
		setJustSignedIn(false);
		setSynced(false);
		for (const listener of signOutListeners.current) listener();
		clearAllBotRuns();
		// O cache sai antes de o servidor ser avisado e sem depender do efeito de fase (que pode nem rodar).
		await clearHomeCacheLogged();
		try {
			await client?.signOut();
		} catch {
			// sem rede: o cliente já apagou a sessão guardada no aparelho antes de chamar o servidor
		}
	}, [client]);

	const changeServer = React.useCallback(async () => {
		await signOut();
		await clearHomeCacheLogged();
		await clearServerUrl();
		setServerUrl(null);
	}, [signOut]);

	const apiFetch = React.useMemo(
		() =>
			client && serverUrl
				? createApiFetch({ baseUrl: serverUrl, getCookie: () => client.getCookie() })
				: async (): Promise<Response> => {
						throw new Error("Nenhum servidor conectado.");
					},
		[client, serverUrl],
	);

	const openRunStream = React.useCallback(
		(runId: string): OpenStream => {
			if (!client || !serverUrl) return async () => Promise.reject(new Error("Nenhum servidor conectado."));
			return createRunStreamOpener({ baseUrl: serverUrl, getCookie: () => client.getCookie(), streamFetch: (url, init) => expoFetch(url, init) }, runId);
		},
		[client, serverUrl],
	);

	const phase = phaseOf({ loaded, serverUrl, sessionPending: pending, hasSession });
	const phaseRef = React.useRef<AccessPhase>(phase);
	phaseRef.current = phase;
	// Sem dependências: um closure antigo (do carregamento que ficou lento) lê a fase e a saída de agora.
	const markSynced = React.useCallback(() => {
		if (!canMarkSynced({ phase: phaseRef.current, signingOut: signingOut.current })) return false;
		setSynced(true);
		return true;
	}, []);
	const markSignedIn = React.useCallback(() => setJustSignedIn(true), []);
	const consumeJustSignedIn = React.useCallback(() => setJustSignedIn(false), []);
	// Sessão que caiu por fora (expirou, revogada): o próximo login passa de novo pelo carregamento.
	React.useEffect(() => {
		if (phase === "signed-out" || phase === "no-server") setSynced(false);
		if (phase === "signed-in") signingOut.current = false;
	}, [phase]);

	const value = React.useMemo<AtlasSession>(
		() => ({
			phase,
			synced,
			markSynced,
			onSignOut,
			serverUrl,
			client,
			email,
			name,
			image,
			justSignedIn,
			markSignedIn,
			consumeJustSignedIn,
			connectServer,
			signOut,
			changeServer,
			apiFetch,
			openRunStream,
		}),
		[phase, synced, onSignOut, serverUrl, client, email, name, image, justSignedIn, markSynced, markSignedIn, consumeJustSignedIn, connectServer, signOut, changeServer, apiFetch, openRunStream],
	);

	return (
		<Context.Provider value={value}>
			{client && serverUrl ? <SessionProbe key={serverUrl} client={client} url={serverUrl} onChange={setProbe} /> : null}
			{children}
		</Context.Provider>
	);
}

type ProbeState = { url: string; email: string | null; name: string | null; image: string | null; pending: boolean };

type ProbeProps = {
	client: AtlasAuthClient;
	url: string;
	onChange: (state: ProbeState) => void;
};

function SessionProbe({ client, url, onChange }: ProbeProps) {
	const { data, isPending } = client.useSession();
	const email = data?.user?.email ?? null;
	const name = data?.user?.name ?? null;
	const image = data?.user?.image ?? null;
	React.useEffect(() => {
		onChange({ url, email, name, image, pending: isPending });
	}, [url, email, name, image, isPending, onChange]);
	return null;
}
