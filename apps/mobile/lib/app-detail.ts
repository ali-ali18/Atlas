// Detalhe de um aplicativo (`apps/[id]`): o que a tela mostra para um conector nativo, um app do Composio ou um
// conector próprio, e a conferência "já conectou?" do polling. Funções puras, testadas em app-detail.test.ts.
import { type AppAction, type AppRef, composioAction, customAction, needsApiKey, nativeAction } from "./apps";
import type { ComposioConnection, ConnectorSkill, McpConnection, NativeConnector } from "./apps-parse";

export type AppDetail = {
	ref: AppRef;
	name: string;
	/** Texto longo (o catálogo nativo tem um; os demais usam o curto). */
	description: string;
	icon: string | null;
	action: AppAction;
	skills: ConnectorSkill[];
	/** Campo de chave: só quando a pessoa precisa colar uma. */
	apiKey: { label: string; helpUrl: string } | null;
	/** Conta ligada, quando o servidor sabe ("fulano@..."). */
	account: string;
	/** Id que o "Autorizar" (reauth) usa; só conectores nativos e próprios. */
	reauthId: string | null;
	/** Ids que o "Desconectar" remove (o Composio pode ter mais de uma conta do mesmo app: saem todas); vazio = nada a desconectar. */
	disconnectIds: string[];
	/** Aviso simples quando o botão fica desabilitado por algo fora do alcance da pessoa. */
	note: string | null;
};

export function nativeDetail(entry: NativeConnector): AppDetail {
	const action = nativeAction(entry);
	return {
		ref: { kind: "native", id: entry.id },
		name: entry.name,
		description: entry.longDescription,
		icon: entry.icon,
		action,
		skills: entry.skills,
		apiKey: action === "connect" && needsApiKey(entry) ? entry.apiKey : null,
		account: "",
		reauthId: action === "authorize" ? entry.connectionId : null,
		disconnectIds: entry.connectionId ? [entry.connectionId] : [],
		note: action === "unavailable" ? "Este aplicativo ainda não está disponível neste servidor." : action === "soon" ? "Este aplicativo chega em breve." : null,
	};
}

export type ComposioInfo = { slug: string; name: string; description: string; logo: string | null };

/** `failed`: não deu para ler as conexões do Composio; sem saber se já está conectado, não oferece conectar (evita conta duplicada). */
export function composioDetail(info: ComposioInfo, connections: readonly ComposioConnection[], configured: boolean, failed = false): AppDetail {
	const own = connections.filter((item) => item.toolkit === info.slug);
	const action: AppAction = own.length > 0 ? composioAction({ connected: true }) : configured && !failed ? "connect" : "unavailable";
	return {
		ref: { kind: "composio", id: info.slug },
		name: info.name,
		description: info.description,
		icon: info.logo,
		action,
		skills: [],
		apiKey: null,
		account: "",
		reauthId: null,
		disconnectIds: own.map((item) => item.id),
		note: action === "unavailable" ? (failed ? "Não consegui carregar os apps agora. Tente de novo em instantes." : "Ative os apps nas Configurações do site.") : null,
	};
}

export function customDetail(connection: McpConnection): AppDetail {
	const action = customAction(connection);
	return {
		ref: { kind: "custom", id: connection.id },
		name: connection.name,
		description: "Conector adicionado por você.",
		icon: connection.icon,
		action,
		skills: [],
		apiKey: null,
		account: connection.accountLabel,
		reauthId: action === "authorize" ? connection.id : null,
		disconnectIds: [connection.id],
		note: null,
	};
}

/** O conector nativo está ativo? (olha as conexões do dono pelo `catalogId`). */
export function isNativeConnected(connections: readonly McpConnection[], catalogId: string): boolean {
	return connections.some((connection) => connection.catalogId === catalogId && connection.status === "connected");
}

export function isConnectionConnected(connections: readonly McpConnection[], connectionId: string): boolean {
	return connections.some((connection) => connection.id === connectionId && connection.status === "connected");
}

export function isComposioConnected(connections: readonly ComposioConnection[], toolkit: string): boolean {
	return connections.some((connection) => connection.toolkit === toolkit);
}

/** Como o campo de chave decide o botão: vazio (ou só espaços) não conecta. */
export function canSubmitKey(value: string): boolean {
	return value.trim().length > 0;
}
