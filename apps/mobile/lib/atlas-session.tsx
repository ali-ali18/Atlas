import * as React from "react";
import { createApiFetch } from "@/lib/api-fetch";
import { createAtlasAuthClient, type AtlasAuthClient } from "@/lib/auth-client";
import { phaseOf, type AccessPhase } from "@/lib/auth-flow";
import { clearServerUrl, loadServerUrl, saveServerUrl } from "@/lib/server-store";

export type AtlasSession = {
	phase: AccessPhase;
	serverUrl: string | null;
	client: AtlasAuthClient | null;
	email: string | null;
	/** Verdadeiro uma vez, logo depois de entrar nesta execução do app (para o avatar feliz). */
	justSignedIn: boolean;
	markSignedIn: () => void;
	consumeJustSignedIn: () => void;
	connectServer: (url: string) => Promise<void>;
	/** Encerra a sessão (mesmo sem rede: o app esquece o cookie) e fica no mesmo servidor. */
	signOut: () => Promise<void>;
	/** Encerra a sessão e esquece o servidor. */
	changeServer: () => Promise<void>;
	apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
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
	const [probe, setProbe] = React.useState<{ url: string; email: string | null; pending: boolean } | null>(null);
	const reading = client && serverUrl && probe?.url === serverUrl ? probe : null;
	const email = reading?.email ?? null;
	const pending = Boolean(client) && (reading ? reading.pending : true);
	const hasSession = email !== null;

	const signOut = React.useCallback(async () => {
		setJustSignedIn(false);
		try {
			await client?.signOut();
		} catch {
			// sem rede: o cliente já apagou a sessão guardada no aparelho antes de chamar o servidor
		}
	}, [client]);

	const changeServer = React.useCallback(async () => {
		await signOut();
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

	const value = React.useMemo<AtlasSession>(
		() => ({
			phase: phaseOf({ loaded, serverUrl, sessionPending: pending, hasSession }),
			serverUrl,
			client,
			email,
			justSignedIn,
			markSignedIn: () => setJustSignedIn(true),
			consumeJustSignedIn: () => setJustSignedIn(false),
			connectServer,
			signOut,
			changeServer,
			apiFetch,
		}),
		[loaded, serverUrl, pending, hasSession, client, email, justSignedIn, connectServer, signOut, changeServer, apiFetch],
	);

	return (
		<Context.Provider value={value}>
			{client && serverUrl ? <SessionProbe key={serverUrl} client={client} url={serverUrl} onChange={setProbe} /> : null}
			{children}
		</Context.Provider>
	);
}

type ProbeProps = {
	client: AtlasAuthClient;
	url: string;
	onChange: (state: { url: string; email: string | null; pending: boolean }) => void;
};

function SessionProbe({ client, url, onChange }: ProbeProps) {
	const { data, isPending } = client.useSession();
	const email = data?.user?.email ?? null;
	React.useEffect(() => {
		onChange({ url, email, pending: isPending });
	}, [url, email, isPending, onChange]);
	return null;
}
