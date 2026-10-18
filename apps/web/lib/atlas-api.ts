import type {
	AccountSettingsResponse,
	AutonomyUpdateInput,
	AutonomyView,
	Bot,
	BotExchangeResponse,
	ChatCompletionJobEnqueueResponse,
	ChatCompletionJobStatusResponse,
	ChatCompletionRequest,
	AgentPointerEvent,
	ChatMessage,
	MessageReaction,
	ComputerUseEvent,
	ComputerUseRequest,
	RunUsage,
	CreateBotInput,
	CreateGroupInput,
	GroupStateResponse,
	PostGroupMessageResponse,
	CreateConversationResponse,
	ListBotsResponse,
	ListModelsResponse,
	TranscriptionModelsResponse,
	ListProvidersResponse,
	ProviderModelsResponse,
	ApiKeyProvider,
	ApiKeyProviderStatus,
	OpenRouterModel,
	RunEventRecord,
	SandboxSessionResponse,
	SessionMessage,
	SkillListItemData,
	UpdateAccountSettingsInput,
	UsagePeriod,
	UsageResponse,
	UpdateBotInput,
	CreateRoutineInput,
	CreateSectionInput,
	ListSectionsResponse,
	RoutineRecord,
	RoutineGithubTriggerView,
	RoutineRunListItem,
	RoutineRunRecord,
	Section,
	ComposioConnectedAppView,
	ComposioStatusView,
	ComposioCategoryView,
	ComposioToolkitsPageView,
	ComposioToolkitView,
	McpCatalogEntry,
	ApiConnectionView,
	ApiOperation,
	ApiProposal,
	McpConnectionStatus,
	McpConnectionView,
	UpdateRoutineInput,
	UpdateSectionInput,
	SkillProposalEvent,
	BotProposalEvent,
	RunInputMode,
} from "@workspace/shared";
import type { MemoryChange, MemoryChangesPage, MemoryEntry, MemorySnapshot, MemoryTarget } from "@workspace/shared";
import type {
	CatalogBotEntry,
	CatalogBotTemplate,
	CatalogChangelogEntry,
	CatalogSkillEntry,
	ScanFinding,
	TextDiff,
} from "@workspace/shared";
import { parseSseBlock, type DevApprovalCardInfo, type DevSessionEvent, type DevTimingEvent, type FilePreview, type LoginConnector } from "@workspace/shared";
import { filePreviewPath } from "@/lib/file-card";
import { getStoredSseCursor, setStoredSseCursor } from "@/lib/active-run";
import { isJevToolReview, type JevToolReview } from "@/lib/jev-status";
import { isStreamIdle, subscribeAppResume } from "@/lib/resume-sync";
import { createSseReplayGuard } from "@/lib/sse-replay";

export function getAtlasApiBaseUrl(): string {
	return "";
}

export class AtlasApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		/** Corpo JSON da resposta de erro (ex.: o resumo de diferenças do marketplace). */
		readonly details?: unknown,
	) {
		super(message);
		this.name = "AtlasApiError";
	}
}

export type UploadedImage = {
	id: string;
	mime: string;
	width: number;
	height: number;
	name: string;
	url: string;
};

/** Upload multipart preserva o boundary gerado pelo navegador. */
export async function uploadImage(file: File, signal?: AbortSignal): Promise<UploadedImage> {
	const body = new FormData();
	body.set("file", file);
	const response = await fetch(`${getAtlasApiBaseUrl()}/v1/uploads/images`, {
		method: "POST",
		body,
		credentials: "same-origin",
		signal,
	});
	if (!response.ok) return throwApiError(response);
	return (await response.json()) as UploadedImage;
}

export type UploadedFile = {
	id: string;
	name: string;
	mime: string;
	size: number;
	kind: string;
	url: string;
};

/** Anexo de arquivo (PDF, Office, planilha, texto, zip...); o tipo é validado no servidor. */
export async function uploadFileAttachment(file: File, signal?: AbortSignal): Promise<UploadedFile> {
	const body = new FormData();
	body.set("file", file);
	const response = await fetch(`${getAtlasApiBaseUrl()}/v1/uploads/files`, {
		method: "POST",
		body,
		credentials: "same-origin",
		signal,
	});
	if (!response.ok) return throwApiError(response);
	return (await response.json()) as UploadedFile;
}

/** Modelos de ditado disponíveis (OpenRouter ou lista fixa OpenAI) e o padrão do servidor. */
export async function getTranscriptionModels(): Promise<TranscriptionModelsResponse> {
	return atlasFetch<TranscriptionModelsResponse>("/v1/transcriptions/models");
}

/** O servidor tem transcrição (STT) configurada? Sem ela, o ditado usa só o navegador. */
export async function getTranscriptionStatus(): Promise<{ available: boolean }> {
	return atlasFetch<{ available: boolean }>("/v1/transcriptions/status");
}

/** Falhas de gateway/proxy (Traefik, rewrite do Next) que valem uma nova tentativa: o envio é idempotente. */
export function isRetryableDictationStatus(status: number): boolean {
	return status === 500 || status === 502 || status === 504;
}

/** Mensagem para o usuário quando a resposta não veio da API (corpo não-JSON de proxy) ou veio de rede. */
export function dictationGatewayMessage(status: number | null): string {
	if (status === 413) return "O áudio ficou grande demais. Faça um ditado mais curto.";
	if (status === 504) return "A transcrição demorou demais. Tente um ditado mais curto.";
	if (status === null) return "Sem conexão com o servidor. Verifique a internet e tente de novo.";
	return "O servidor não respondeu a tempo. Tente de novo em instantes.";
}

async function dictationErrorFrom(response: Response): Promise<AtlasApiError> {
	let apiMessage: string | null = null;
	try {
		const body = (await response.json()) as { error?: unknown };
		if (typeof body.error === "string" && body.error.trim()) apiMessage = body.error;
	} catch {
		// corpo não-JSON: resposta do proxy, não da API
	}
	if (response.status === 401 && typeof window !== "undefined" && window.location.pathname !== "/login") {
		window.location.replace("/login");
	}
	return new AtlasApiError(apiMessage ?? dictationGatewayMessage(response.status), response.status);
}

/**
 * Envia o áudio do ditado (multipart, não é guardado) e devolve o texto final.
 * Uma nova tentativa em 500/502/504 ou falha de rede (causas típicas em produção: proxy/Traefik).
 */
export async function transcribeDictation(
	audio: Blob,
	info: { language?: string; durationMs?: number },
	signal?: AbortSignal,
	options: { retryDelayMs?: number } = {},
): Promise<string> {
	const body = new FormData();
	body.set("file", audio, "ditado");
	if (info.language) body.set("language", info.language);
	if (info.durationMs !== undefined) body.set("durationMs", String(Math.round(info.durationMs)));
	let lastError: AtlasApiError | null = null;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 700));
		if (signal?.aborted) break;
		let response: Response;
		try {
			response = await fetch(`${getAtlasApiBaseUrl()}/v1/transcriptions`, {
				method: "POST",
				body,
				credentials: "same-origin",
				signal,
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			lastError = new AtlasApiError(dictationGatewayMessage(null), 0);
			continue;
		}
		if (response.ok) {
			const result = (await response.json()) as { text?: unknown };
			return typeof result.text === "string" ? result.text : "";
		}
		lastError = await dictationErrorFrom(response);
		if (!isRetryableDictationStatus(response.status)) throw lastError;
	}
	throw lastError ?? new AtlasApiError(dictationGatewayMessage(null), 0);
}

async function parseErrorMessage(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: string; fields?: Array<{ message?: unknown }> };
		// Validação por campo (ex.: PATCH /v1/settings): a mensagem do campo explica melhor que o título.
		const field = body.fields?.find((item) => typeof item?.message === "string" && item.message.trim());
		if (field) return field.message as string;
		if (body.error) return body.error;
	} catch {
		// ignore
	}
	return response.statusText || `HTTP ${response.status}`;
}

async function throwApiError(response: Response): Promise<never> {
	if (response.status === 401 && typeof window !== "undefined" && window.location.pathname !== "/login") {
		window.location.replace("/login");
	}
	const details = await response.clone().json().catch(() => undefined);
	const message = await parseErrorMessage(response);
	throw new AtlasApiError(message, response.status, details);
}

async function atlasFetch<T>(
	path: string,
	init?: RequestInit,
): Promise<T> {
	const base = getAtlasApiBaseUrl();
	const response = await fetch(`${base}${path}`, {
		...init,
		credentials: "same-origin",
		headers: {
			"Content-Type": "application/json",
			...init?.headers,
		},
	});

	if (!response.ok) {
		return throwApiError(response);
	}
	if (response.status === 204) return undefined as T;

	return (await response.json()) as T;
}

export type McpCatalogItem = Omit<McpCatalogEntry, "oauth"> & {
	oauth?: { setupUrl?: string };
	/** Login com um clique disponível (app OAuth configurado no .env). */
	oauthReady: boolean;
	oauthMissingEnv: string[];
	connectionId: string | null;
	status: McpConnectionStatus | null;
};

export type McpOAuthStartResult = {
	connection: McpConnectionView;
	/** `null` quando o token ainda valia e já conectou. */
	authorizeUrl: string | null;
};

/** Inicia o login OAuth de um conector (catálogo ou personalizado). */
export async function startMcpOAuth(
	input: { catalogId: string; newAccount?: boolean } | { custom: { name: string; url: string; oauth: true } },
): Promise<McpOAuthStartResult> {
	return atlasFetch<McpOAuthStartResult>("/v1/mcp/connections", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export async function reauthMcpConnection(id: string): Promise<McpOAuthStartResult> {
	return atlasFetch<McpOAuthStartResult>(
		`/v1/mcp/connections/${encodeURIComponent(id)}/reauth`,
		{ method: "POST" },
	);
}

type McpOAuthMessage = { type: "atlas:mcp-oauth"; ok: boolean; connectionId?: string; error?: string };

/**
 * Abre o popup de login e espera a página de callback da API avisar. Chame
 * `openMcpOAuthPopup()` no clique (antes de qualquer await) para o navegador
 * não bloquear o popup; depois `waitMcpOAuthPopup` com a URL.
 */
export function openMcpOAuthPopup(): Window | null {
	const width = 520;
	const height = 720;
	const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
	const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
	return window.open("about:blank", "atlas-mcp-oauth", `popup,width=${width},height=${height},left=${left},top=${top}`);
}

export function waitMcpOAuthPopup(
	popup: Window | null,
	authorizeUrl: string,
): Promise<{ ok: boolean; error?: string; closed?: boolean }> {
	if (!popup || popup.closed) {
		// Popup bloqueado: segue na mesma aba não dá (perde o estado); avisa.
		return Promise.resolve({ ok: false, error: "O navegador bloqueou a janela de login. Permita popups e tente de novo." });
	}
	popup.location.href = authorizeUrl;
	return new Promise((resolve) => {
		let done = false;
		const finish = (result: { ok: boolean; error?: string; closed?: boolean }) => {
			if (done) return;
			done = true;
			window.removeEventListener("message", onMessage);
			window.clearInterval(timer);
			resolve(result);
		};
		// Só a nossa janela de login conta (localhost x 127.0.0.1 mudam a
		// origem). A mensagem só adianta o fim: quem decide é o status recarregado.
		const onMessage = (event: MessageEvent) => {
			if (event.source !== popup) return;
			const data = event.data as Partial<McpOAuthMessage> | null;
			if (data?.type !== "atlas:mcp-oauth") return;
			finish({ ok: !!data.ok, error: data.error });
		};
		window.addEventListener("message", onMessage);
		// Fechou sem terminar: o chamador recarrega o status de qualquer jeito.
		const timer = window.setInterval(() => {
			if (popup.closed) finish({ ok: false, error: "Login não concluído.", closed: true });
		}, 700);
	});
}

export async function getMcpCatalog(): Promise<{
	entries: McpCatalogItem[];
	secretBoxReady: boolean;
}> {
	return atlasFetch("/v1/mcp/catalog");
}

export async function listMcpConnections(): Promise<McpConnectionView[]> {
	const body = await atlasFetch<{ connections: McpConnectionView[] }>(
		"/v1/mcp/connections",
	);
	return body.connections;
}

export async function createMcpConnection(
	input:
		| { catalogId: string; apiKey?: string; newAccount?: boolean }
		| {
				custom: {
					name: string;
					url: string;
					headerName?: string;
					headerValue?: string;
				};
			},
): Promise<McpConnectionView> {
	const body = await atlasFetch<{ connection: McpConnectionView }>(
		"/v1/mcp/connections",
		{ method: "POST", body: JSON.stringify(input) },
	);
	return body.connection;
}

export async function updateMcpConnection(
	id: string,
	patch: { disabledTools?: string[]; confirmWrites?: boolean; name?: string; accountLabel?: string | null },
): Promise<McpConnectionView> {
	const body = await atlasFetch<{ connection: McpConnectionView }>(
		`/v1/mcp/connections/${encodeURIComponent(id)}`,
		{ method: "PATCH", body: JSON.stringify(patch) },
	);
	return body.connection;
}

export async function refreshMcpConnection(id: string): Promise<McpConnectionView> {
	const body = await atlasFetch<{ connection: McpConnectionView }>(
		`/v1/mcp/connections/${encodeURIComponent(id)}/refresh`,
		{ method: "POST" },
	);
	return body.connection;
}

export async function deleteMcpConnection(id: string): Promise<void> {
	await atlasFetch<void>(`/v1/mcp/connections/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
}

/** Conexões de API (OpenAPI): aprovação do card, login, grupos de acesso. */
export type ApiConnectionStartResult = {
	connection: ApiConnectionView;
	/** `null` quando conectou direto (chave/token). */
	authorizeUrl: string | null;
};

export async function listApiConnections(): Promise<ApiConnectionView[]> {
	const body = await atlasFetch<{ connections: ApiConnectionView[] }>("/v1/api-connections");
	return body.connections;
}

/** Operações (catálogo) de uma conexão de API: base do guia de cada consulta. */
export async function listApiOperations(id: string): Promise<ApiOperation[]> {
	const body = await atlasFetch<{ operations: ApiOperation[] }>(`/v1/api-connections/${encodeURIComponent(id)}/operations`);
	return body.operations;
}

/** Aprova o card: as credenciais vão direto ao servidor (cofre), nunca ao chat nem ao modelo. */
export async function createApiConnection(input: {
	specUrl: string;
	allowedTags?: string[];
	clientId?: string;
	clientSecret?: string;
	apiKey?: string;
	/** Outra conta da mesma API: cria uma conexão nova em vez de atualizar a existente. */
	newAccount?: boolean;
}): Promise<ApiConnectionStartResult> {
	return atlasFetch<ApiConnectionStartResult>("/v1/api-connections", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

/** Caminho manual: o servidor lê o link (mesma descoberta da tool) e devolve o resumo do card. Nada é gravado. */
export async function discoverApi(url: string): Promise<ApiProposal> {
	const body = await atlasFetch<{ proposal: ApiProposal }>("/v1/api-connections/discover", {
		method: "POST",
		body: JSON.stringify({ url }),
	});
	return body.proposal;
}

export async function reauthApiConnection(id: string, input: { apiKey?: string } = {}): Promise<ApiConnectionStartResult> {
	return atlasFetch<ApiConnectionStartResult>(`/v1/api-connections/${encodeURIComponent(id)}/reauth`, {
		method: "POST",
		body: JSON.stringify(input),
	});
}

/** "Adicionar outra conta": o resumo da API de uma conexão existente (relido da especificação guardada). */
export async function getApiAccountProposal(id: string): Promise<ApiProposal> {
	const body = await atlasFetch<{ proposal: ApiProposal }>(`/v1/api-connections/${encodeURIComponent(id)}/proposal`, { method: "POST", body: "{}" });
	return body.proposal;
}

export async function updateApiConnection(id: string, patch: { allowedTags?: string[]; name?: string; accountLabel?: string | null }): Promise<ApiConnectionView> {
	const body = await atlasFetch<{ connection: ApiConnectionView }>(`/v1/api-connections/${encodeURIComponent(id)}`, {
		method: "PATCH",
		body: JSON.stringify(patch),
	});
	return body.connection;
}

export async function deleteApiConnection(id: string): Promise<void> {
	await atlasFetch<void>(`/v1/api-connections/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Autonomia do agente (F10): padrão da conta e override por bot. */
export async function getAccountAutonomy(): Promise<AutonomyView> {
	return atlasFetch<AutonomyView>("/v1/autonomy");
}

export async function updateAccountAutonomy(
	update: AutonomyUpdateInput,
): Promise<AutonomyView> {
	return atlasFetch<AutonomyView>("/v1/autonomy", {
		method: "PUT",
		body: JSON.stringify(update),
	});
}

export async function getBotAutonomy(botId: string): Promise<AutonomyView> {
	return atlasFetch<AutonomyView>(
		`/v1/bots/${encodeURIComponent(botId)}/autonomy`,
	);
}

export async function updateBotAutonomy(
	botId: string,
	update: AutonomyUpdateInput,
): Promise<AutonomyView> {
	return atlasFetch<AutonomyView>(
		`/v1/bots/${encodeURIComponent(botId)}/autonomy`,
		{ method: "PUT", body: JSON.stringify(update) },
	);
}

/** Configurações da conta (`GET`/`PATCH /v1/settings`): o que o usuário gravou + valor efetivo e origem. */
export async function getAccountSettings(): Promise<AccountSettingsResponse> {
	return atlasFetch<AccountSettingsResponse>("/v1/settings");
}

/** Merge patch: `null` remove a chave (volta a herdar), ausente não muda. */
export async function patchAccountSettings(
	input: UpdateAccountSettingsInput,
): Promise<AccountSettingsResponse> {
	return atlasFetch<AccountSettingsResponse>("/v1/settings", {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export async function createConversation(): Promise<string> {
	const body = await atlasFetch<CreateConversationResponse>(
		"/v1/conversations",
		{ method: "POST" },
	);
	return body.id;
}

export async function listBots(): Promise<Bot[]> {
	const body = await atlasFetch<ListBotsResponse>("/v1/bots");
	return body.bots;
}

/** Abriu a conversa: resultados de runs em background contam como vistos (some o badge). */
export async function markConversationResultsSeen(conversationId: string): Promise<void> {
	await atlasFetch(`/v1/conversations/${encodeURIComponent(conversationId)}/results/seen`, { method: "POST" });
}

export type ConversationReadState = { unreadCount: number; firstUnreadMessageId: string | null; manualUnread: boolean };

/** Estado de leitura atual no servidor (fonte da linha "Novas mensagens" ao entrar na conversa). */
export async function getConversationReadState(conversationId: string): Promise<ConversationReadState> {
	return atlasFetch<ConversationReadState>(`/v1/conversations/${encodeURIComponent(conversationId)}/read`);
}

/** Marca como lida até a mensagem (monotônico no servidor). Sem id, vale "agora". */
export async function markConversationRead(conversationId: string, upToMessageId?: string): Promise<ConversationReadState> {
	return atlasFetch<ConversationReadState>(`/v1/conversations/${encodeURIComponent(conversationId)}/read`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(upToMessageId ? { upToMessageId } : {}),
	});
}

/** "Marcar como não lido": vale em todos os dispositivos. */
export async function markConversationUnread(conversationId: string): Promise<ConversationReadState> {
	return atlasFetch<ConversationReadState>(`/v1/conversations/${encodeURIComponent(conversationId)}/unread`, { method: "POST" });
}

export type PushConfig = { enabled: boolean; publicKey: string | null };
export type PushDevice = { id: string; label: string; createdAt: string; lastUsedAt: string; failing: boolean };
export type PushDevicesResponse = { devices: PushDevice[]; endpoints: Array<{ id: string; endpoint: string }> };

/** Notificações no celular: o servidor tem as chaves VAPID? Qual a chave pública? */
export async function getPushConfig(): Promise<PushConfig> {
	return atlasFetch<PushConfig>("/v1/push/config");
}

export async function listPushDevices(): Promise<PushDevicesResponse> {
	return atlasFetch<PushDevicesResponse>("/v1/push/subscriptions");
}

/** Registra este aparelho (`PushSubscription.toJSON()` do navegador). */
export async function savePushDevice(subscription: unknown): Promise<{ id: string; label: string }> {
	return atlasFetch<{ id: string; label: string }>("/v1/push/subscriptions", { method: "POST", body: JSON.stringify(subscription) });
}

export async function removePushDevice(id: string): Promise<void> {
	await atlasFetch(`/v1/push/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function unsubscribePushEndpoint(endpoint: string): Promise<void> {
	await atlasFetch("/v1/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) });
}

export async function sendPushTest(): Promise<{ sent: number; deleted: number; failed: number; devices: number }> {
	return atlasFetch("/v1/push/test", { method: "POST", body: "{}" });
}

/** Sinal de que ESTE cliente está olhando a conversa (a cada 20s) ou parou; suprime a notificação. */
export async function sendViewingSignal(conversationId: string, clientId: string, viewing: boolean, keepalive = false): Promise<void> {
	await atlasFetch(`/v1/conversations/${encodeURIComponent(conversationId)}/viewing`, {
		method: "POST",
		body: JSON.stringify({ clientId, viewing }),
		keepalive,
	});
}

/** Conversa (somente leitura) entre dois bots; `cursor` busca trocas mais antigas. */
export async function listBotExchange(
	botId: string,
	peerBotId: string,
	options: { limit?: number; cursor?: string | null } = {},
): Promise<BotExchangeResponse> {
	const query = new URLSearchParams();
	if (options.limit) query.set("limit", String(options.limit));
	if (options.cursor) query.set("cursor", options.cursor);
	const suffix = query.size > 0 ? `?${query}` : "";
	return atlasFetch<BotExchangeResponse>(
		`/v1/bots/${encodeURIComponent(botId)}/exchanges/${encodeURIComponent(peerBotId)}${suffix}`,
	);
}

export type BotLibraryFile = {
	id: string;
	filename: string;
	size: number;
	version: number;
	mime: string;
	createdAt: string;
};

/** Biblioteca do bot: arquivos que ele criou, mais novos primeiro. */
export async function listBotArtifacts(
	botId: string,
	options: { limit?: number; cursor?: string | null } = {},
): Promise<{ files: BotLibraryFile[]; nextCursor: string | null }> {
	const query = new URLSearchParams();
	if (options.limit) query.set("limit", String(options.limit));
	if (options.cursor) query.set("cursor", options.cursor);
	const suffix = query.size > 0 ? `?${query}` : "";
	return atlasFetch(`/v1/bots/${encodeURIComponent(botId)}/artifacts${suffix}`);
}

// --- Aba Memória: o que o bot lembra, edição e histórico com desfazer ---

/** As duas seções (perfil do usuário e memória deste bot), com ids. */
export async function getBotMemory(botId: string): Promise<MemorySnapshot> {
	const { snapshot } = await atlasFetch<{ snapshot: MemorySnapshot }>(`/v1/memory?botId=${encodeURIComponent(botId)}`);
	return snapshot;
}

export async function addMemoryItem(input: { target: MemoryTarget; content: string; botId: string }): Promise<MemoryEntry> {
	const { entry } = await atlasFetch<{ entry: MemoryEntry }>("/v1/memory", { method: "POST", body: JSON.stringify(input) });
	return entry;
}

export async function editMemoryItem(entryId: string, content: string): Promise<MemoryEntry> {
	const { entry } = await atlasFetch<{ entry: MemoryEntry }>(`/v1/memory/entries/${encodeURIComponent(entryId)}`, { method: "PATCH", body: JSON.stringify({ content }) });
	return entry;
}

export async function deleteMemoryItem(entryId: string): Promise<void> {
	await atlasFetch(`/v1/memory/entries/${encodeURIComponent(entryId)}`, { method: "DELETE" });
}

/** "O que mudou": últimos 30 dias, mais novas primeiro. */
export async function listMemoryHistory(botId: string, options: { cursor?: string | null; limit?: number } = {}): Promise<MemoryChangesPage> {
	const query = new URLSearchParams({ botId });
	if (options.cursor) query.set("cursor", options.cursor);
	if (options.limit) query.set("limit", String(options.limit));
	return atlasFetch<MemoryChangesPage>(`/v1/memory/changes?${query}`);
}

/** Desfaz uma mudança; entrada alterada depois responde 409 com a mensagem em pt-BR (vira `AtlasApiError.message`). */
export async function undoMemoryHistoryItem(changeId: string): Promise<MemoryChange> {
	const { change } = await atlasFetch<{ change: MemoryChange }>(`/v1/memory/changes/${encodeURIComponent(changeId)}/undo`, { method: "POST" });
	return change;
}

export async function createBot(input: CreateBotInput): Promise<Bot> {
	return atlasFetch<Bot>("/v1/bots", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export async function updateBot(
	id: string,
	patch: UpdateBotInput,
): Promise<Bot> {
	return atlasFetch<Bot>(`/v1/bots/${encodeURIComponent(id)}`, {
		method: "PATCH",
		body: JSON.stringify(patch),
	});
}

/** Cria um grupo de bots (2 a 8 membros do próprio usuário). */
export async function createGroup(input: CreateGroupInput): Promise<Bot> {
	return atlasFetch<Bot>("/v1/groups", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export async function addGroupMember(groupId: string, botId: string): Promise<Bot> {
	return atlasFetch<Bot>(`/v1/groups/${encodeURIComponent(groupId)}/members`, {
		method: "POST",
		body: JSON.stringify({ botId }),
	});
}

export async function removeGroupMember(groupId: string, botId: string): Promise<Bot> {
	return atlasFetch<Bot>(
		`/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(botId)}`,
		{ method: "DELETE" },
	);
}

/** Fala do usuário no grupo; o servidor decide quem responde. */
export async function postGroupMessage(groupId: string, content: string): Promise<PostGroupMessageResponse> {
	return atlasFetch<PostGroupMessageResponse>(`/v1/groups/${encodeURIComponent(groupId)}/messages`, {
		method: "POST",
		body: JSON.stringify({ content }),
	});
}

/** Quem está respondendo agora e quem está na fila. */
export async function getGroupState(groupId: string): Promise<GroupStateResponse> {
	return atlasFetch<GroupStateResponse>(`/v1/groups/${encodeURIComponent(groupId)}/state`);
}

export async function deleteBot(id: string): Promise<void> {
	await atlasFetch<{ ok: boolean }>(`/v1/bots/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
}

export async function listSections(): Promise<Section[]> {
	const body = await atlasFetch<ListSectionsResponse>("/v1/sections");
	return body.sections;
}

export async function createSection(input: CreateSectionInput): Promise<Section> {
	return atlasFetch<Section>("/v1/sections", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export async function updateSection(
	id: string,
	patch: UpdateSectionInput,
): Promise<Section> {
	return atlasFetch<Section>(`/v1/sections/${encodeURIComponent(id)}`, {
		method: "PATCH",
		body: JSON.stringify(patch),
	});
}

export async function deleteSection(id: string): Promise<void> {
	await atlasFetch<{ ok: boolean }>(`/v1/sections/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
}

export async function listConversationMessages(
	conversationId: string,
): Promise<SessionMessage[]> {
	const page = await listConversationMessagePage(conversationId);
	return page.messages;
}

export type DevSessionSummaryResponse = {
	id: string;
	conversationId: string | null;
	status: import("@workspace/shared").DevSessionStatusValue;
	tier: import("@workspace/shared").DevSessionTierValue;
	repo: string | null;
	branch: string | null;
	baseBranch: string | null;
	startedAt: string;
	lastActiveAt: string;
	/** Pull request atual da sessão (null sem PR). */
	pr?: import("@workspace/shared").DevPrInfo | null;
};

export type DevSessionDetailResponse = DevSessionSummaryResponse & {
	todos: import("@workspace/shared").DevTodoItemValue[];
	stats: {
		commandsRun: number;
		filesChanged: { path: string; added: number; removed: number }[];
		totalAdded: number;
		totalRemoved: number;
		lastActivityAt: string | null;
	};
};

/** Sessões de desenvolvimento da conversa (recarregar a página não perde os cartões). */
export async function listDevSessions(conversationId: string): Promise<DevSessionSummaryResponse[]> {
	const result = await atlasFetch<{ sessions: DevSessionSummaryResponse[] }>(
		`/v1/dev-sessions?conversationId=${encodeURIComponent(conversationId)}`,
	);
	return result.sessions;
}

export async function getDevSessionDetail(id: string): Promise<DevSessionDetailResponse> {
	return atlasFetch<DevSessionDetailResponse>(`/v1/dev-sessions/${encodeURIComponent(id)}`);
}

export type DevHistoryResponse = {
	events: Array<{ id: string; runId: string; seq: number; type: string; payload: Record<string, unknown>; createdAt: string }>;
	nextAfter: string | null;
};

/** Histórico persistido da sessão (comandos, diffs, tarefas), para o painel após recarregar. */
export async function getDevSessionEvents(id: string, after?: string): Promise<DevHistoryResponse> {
	const query = after ? `?after=${encodeURIComponent(after)}` : "";
	return atlasFetch<DevHistoryResponse>(`/v1/dev-sessions/${encodeURIComponent(id)}/events${query}`);
}

/** Para a sessão (e, por padrão, o run em andamento da conversa). */
export async function stopDevSession(id: string): Promise<{ ok: boolean; status: string; cancelledRuns: string[] }> {
	return atlasFetch(`/v1/dev-sessions/${encodeURIComponent(id)}/stop`, { method: "POST" });
}

export async function resumeDevSession(id: string): Promise<{ ok: boolean; status: string }> {
	return atlasFetch(`/v1/dev-sessions/${encodeURIComponent(id)}/resume`, { method: "POST" });
}

export type DevCiRefreshResponse = {
	pr: import("@workspace/shared").DevPrInfo;
	checks: import("@workspace/shared").DevCiCheck[];
	summary: import("@workspace/shared").DevCiSummary;
};

/** Consulta o GitHub agora (PR + checks) sem passar pelo agente; 409 = sem PR ou sessão parada. */
export async function refreshDevSessionCi(id: string): Promise<DevCiRefreshResponse> {
	return atlasFetch(`/v1/dev-sessions/${encodeURIComponent(id)}/ci/refresh`, { method: "POST" });
}

export async function killDevJob(sessionId: string, jobId: string): Promise<{ ok: boolean; running: boolean }> {
	return atlasFetch(`/v1/dev-sessions/${encodeURIComponent(sessionId)}/jobs/${encodeURIComponent(jobId)}/kill`, { method: "POST" });
}

export type ActiveWorkItemResponse =
	| {
			kind: "dev";
			id: string;
			conversationId: string | null;
			conversationTitle: string | null;
			botId: string | null;
			status: import("@workspace/shared").DevSessionStatusValue;
			repo: string | null;
			branch: string | null;
			startedAt: string;
			lastActiveAt: string;
			awaitingApproval: boolean;
	  }
	| {
			kind: "subagent";
			id: string;
			conversationId: string | null;
			conversationTitle: string | null;
			botId: string | null;
			title: string;
			startedAt: string;
			awaitingApproval: boolean;
	  };

/** Sessões de código e subagentes em andamento, de todas as conversas do usuário. */
export async function listActiveWork(): Promise<ActiveWorkItemResponse[]> {
	return (await atlasFetch<{ items: ActiveWorkItemResponse[] }>("/v1/dev-sessions/active")).items;
}

/** "Deixar para quando terminar": a mensagem pendente vira fila (roda depois do run). */
export async function queueRunInputForLater(runId: string, inputId: string): Promise<void> {
	await atlasFetch(`/v1/runs/${encodeURIComponent(runId)}/inputs/${encodeURIComponent(inputId)}/queue`, { method: "POST" });
}

/** Ids das mensagens do run que o agente ainda não usou. */
export async function listPendingRunInputIds(runId: string): Promise<string[]> {
	const { inputs } = await atlasFetch<{ inputs: Array<{ id: string }> }>(`/v1/runs/${encodeURIComponent(runId)}/inputs?status=pending`);
	return inputs.map((input) => input.id);
}

/** "Enviar agora": a mensagem da fila entra no run em andamento. */
export async function steerQueuedInput(runId: string, inputId: string): Promise<void> {
	await atlasFetch(`/v1/runs/${encodeURIComponent(runId)}/inputs/${encodeURIComponent(inputId)}/steer`, { method: "POST" });
}

export async function listConversationMessagePage(
	conversationId: string,
	options?: {
		limit?: number;
		before?: { createdAt: string; id: string };
	},
): Promise<{ messages: SessionMessage[]; hasMore: boolean }> {
	const params = new URLSearchParams();
	if (options?.limit !== undefined) {
		params.set("limit", String(options.limit));
	}
	if (options?.before) {
		params.set("beforeCreatedAt", options.before.createdAt);
		params.set("beforeId", options.before.id);
	}
	const query = params.size > 0 ? `?${params.toString()}` : "";
	return atlasFetch<{ messages: SessionMessage[]; hasMore: boolean }>(
		`/v1/conversations/${encodeURIComponent(conversationId)}/messages${query}`,
	);
}

export async function listOpenRouterModels(): Promise<OpenRouterModel[]> {
	const body = await atlasFetch<ListModelsResponse>("/v1/models");
	return body.models;
}

export type ChatStreamEvent =
	| { type: "delta"; delta: string }
	| {
			type: "done";
			message: ChatMessage;
			model: string;
		}
	| { type: "error"; error: string };

export async function streamChatCompletion(
	request: ChatCompletionRequest,
	handlers: {
		onDelta: (delta: string) => void;
		onDone?: (result: {
			message: ChatMessage;
			model: string;
		}) => void;
	},
	options?: { signal?: AbortSignal },
): Promise<void> {
	const base = getAtlasApiBaseUrl();
	const response = await fetch(`${base}/v1/chat/stream`, {
		method: "POST",
		credentials: "same-origin",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request),
		signal: options?.signal,
	});

	if (!response.ok) {
		return throwApiError(response);
	}

	if (!response.body) {
		throw new AtlasApiError("Resposta de streaming vazia", 502);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		const parts = buffer.split("\n\n");
		buffer = parts.pop() ?? "";

		for (const part of parts) {
			const line = part
				.split("\n")
				.map((row) => row.trim())
				.find((row) => row.startsWith("data:"));
			if (!line) continue;

			let event: ChatStreamEvent;
			try {
				event = JSON.parse(line.slice(5).trim()) as ChatStreamEvent;
			} catch {
				continue;
			}

			switch (event.type) {
				case "delta":
					handlers.onDelta(event.delta);
					break;
				case "done":
					handlers.onDone?.({
						message: event.message,
						model: event.model,
					});
					break;
				case "error":
					throw new AtlasApiError(event.error, 502);
				default:
					break;
			}
		}
	}
}

export async function enqueueChatJob(
	request: ChatCompletionRequest,
): Promise<string> {
	const body = await atlasFetch<ChatCompletionJobEnqueueResponse>(
		"/v1/chat/jobs",
		{
			method: "POST",
			body: JSON.stringify(request),
		},
	);
	return body.jobId;
}

export async function getChatJob(
	jobId: string,
): Promise<ChatCompletionJobStatusResponse> {
	return atlasFetch<ChatCompletionJobStatusResponse>(
		`/v1/chat/jobs/${encodeURIComponent(jobId)}`,
	);
}

export type PollChatJobOptions = {
	intervalMs?: number;
	maxAttempts?: number;
	onStatus?: (status: ChatCompletionJobStatusResponse["status"]) => void;
};

export async function pollChatJobUntilDone(
	jobId: string,
	options: PollChatJobOptions = {},
): Promise<ChatCompletionJobStatusResponse> {
	const intervalMs = options.intervalMs ?? 500;
	const maxAttempts = options.maxAttempts ?? 240;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const status = await getChatJob(jobId);
		options.onStatus?.(status.status);

		if (status.status === "completed" || status.status === "failed") {
			return status;
		}

		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}

	throw new AtlasApiError("Job polling timed out", 408);
}

export async function createSandboxSession(
	conversationId?: string,
): Promise<SandboxSessionResponse> {
	return atlasFetch<SandboxSessionResponse>("/v1/sandbox/sessions", {
		method: "POST",
		body: JSON.stringify(
			conversationId ? { conversationId } : {},
		),
	});
}

export async function getSandboxSession(
	sessionId: string,
): Promise<SandboxSessionResponse> {
	return atlasFetch<SandboxSessionResponse>(
		`/v1/sandbox/sessions/${encodeURIComponent(sessionId)}`,
	);
}

export async function getActiveSandboxSession(
	conversationId: string,
): Promise<SandboxSessionResponse | null> {
	const body = await atlasFetch<{ session: SandboxSessionResponse | null }>(
		`/v1/sandbox/sessions?conversationId=${encodeURIComponent(conversationId)}`,
	);
	return body.session;
}

export async function destroySandboxSession(sessionId: string): Promise<void> {
	await atlasFetch<{ ok: boolean }>(
		`/v1/sandbox/sessions/${encodeURIComponent(sessionId)}`,
		{ method: "DELETE" },
	);
}

/** Digita texto na VM (fallback do teclado quando o noVNC não é acessível). */
export async function sendSandboxText(
	sessionId: string,
	text: string,
): Promise<void> {
	await atlasFetch<{ ok: boolean }>(
		`/v1/sandbox/sessions/${encodeURIComponent(sessionId)}/type`,
		{ method: "POST", body: JSON.stringify({ text }) },
	);
}

/** Pressiona uma tecla na VM (nomes xdotool: Return, BackSpace, Tab). */
export async function sendSandboxKey(
	sessionId: string,
	combo: string,
): Promise<void> {
	await atlasFetch<{ ok: boolean }>(
		`/v1/sandbox/sessions/${encodeURIComponent(sessionId)}/key`,
		{ method: "POST", body: JSON.stringify({ combo }) },
	);
}

export function threadToChatMessages(
	messages: { kind: string; text?: string }[],
): ChatMessage[] {
	return messages
		.filter(
			(message) =>
				message.kind === "user" || message.kind === "assistant",
		)
		.map((message) => ({
			role: message.kind === "user" ? "user" : "assistant",
			content: message.text ?? "",
		}));
}

export type ComputerUseHandlers = {
	onProviderFallback?: (event: Extract<ComputerUseEvent, { type: "provider_fallback" }>) => void;
	onDelta: (id: string, delta: string) => void;
	onDiscard?: () => void;
	onSession?: (session: { sessionId: string; viewerUrl: string }) => void;
	onToolCall?: (call: {
		id: string;
		name: string;
		args: string;
		step?: number;
		maxSteps?: number;
	}) => void;
	onToolResult?: (result: {
		id: string;
		name: string;
		ok: boolean;
		summary: string;
		jev?: JevToolReview;
	}) => void;
	onDone?: (result: { message: ChatMessage; model: string; usage?: RunUsage }) => void;
	onPaused?: (reason?: string) => void;
	onCancelled?: (reason?: string) => void;
	onInputConsumed?: (event: {
		inputId: string;
		mode: string;
		content: string;
	}) => void;
	onInputReceived?: (event: {
		inputId: string;
		mode: string;
		content: string;
	}) => void;
	onStatus?: (status: string, detail?: string) => void;
	onError?: (error: string) => void;
	onRunId?: (runId: string) => void;
	onSkillProposal?: (event: SkillProposalEvent) => void;
	onBotProposal?: (event: BotProposalEvent) => void;
	onSkill?: (event: {
		action: string;
		skillId?: string;
		capabilityKey?: string;
		title?: string;
		versionNumber?: number;
		detail?: string;
		items?: SkillListItemData[];
		draftCount?: number;
	}) => void;
	onRoutine?: (event: {
		action: string;
		routineId?: string;
		title?: string;
		triggerType?: "cron" | "event" | "once" | "interval";
		detail?: string;
		hookUrl?: string;
		hookSecret?: string;
		items?: Array<{
			id: string;
			name: string;
			triggerType: "cron" | "event" | "once" | "interval";
			enabled: boolean;
			schedule?: string | null;
			hookKey?: string;
		}>;
	}) => void;
	onImages?: (event: { origin: "user" | "assistant"; items: Array<{ artifactId: string; mime: string; width: number; height: number; alt?: string; name?: string }>; caption?: string }) => void;
	/** Subagentes do delegate_task (started/tool/done). */
	onSubagent?: (
		event: Extract<
			ComputerUseEvent,
			{ type: "subagent_started" | "subagent_tool" | "subagent_done" }
		>,
	) => void;
	/** Sessão de desenvolvimento (status, setup, shell, edição de arquivo, tarefas). `seq` = posição no log do run (replay). */
	onDevSession?: (event: DevSessionEvent, meta: { seq?: number; runId?: string }) => void;
	/** O contexto do agente foi resumido (divisor "Contexto resumido"). */
	onContextCompacted?: (event: { sessionId?: string; before: number; after: number }, meta: { seq?: number; runId?: string }) => void;
	/** Uso da janela de contexto depois de um passo do modelo (medidor do painel da sessão). */
	onContextUsage?: (
		event: { sessionId?: string; usedTokens: number; windowTokens: number; compactAtTokens: number },
		meta: { seq?: number; runId?: string },
	) => void;
	/** Onde o tempo do run de código foi gasto (painel "Tempo"). */
	onDevTiming?: (event: DevTimingEvent, meta: { seq?: number; runId?: string }) => void;
	onToolBudgetExtended?: (event: {
		tool: string;
		connectorName?: string;
		from: number;
		to: number;
	}) => void;
	onConfirm?: (event: {
		confirmId: string;
		title: string;
		description?: string;
		confirmLabel?: string;
		cancelLabel?: string;
		alwaysLabel?: string;
		devApproval?: DevApprovalCardInfo;
		secretsRequest?: import("@workspace/shared").SecretsRequestInfo;
		githubIdentity?: import("@workspace/shared").GithubIdentityCardInfo;
		status?: "pending" | "approved" | "rejected";
	}) => void;
	onFile?: (event: Extract<ComputerUseEvent, { type: "file" }>) => void;
	/** Cursor do agente no navegador do sandbox (efêmero, só para a UI). */
	onAgentPointer?: (event: AgentPointerEvent) => void;
	onLogin?: (event: {
		loginId: string;
		site: string;
		url: string;
		runId?: string;
		status?: "pending" | "done";
		reason?: "login" | "captcha";
		composioToolkit?: string;
		connector?: LoginConnector;
		vault?: import("@workspace/shared").LoginVaultOffer;
		vaultTried?: string;
		codeField?: boolean;
	}) => void;
};

function dispatchComputerUseEvent(
	event: ComputerUseEvent,
	handlers: ComputerUseHandlers,
	meta: { seq?: number; runId?: string } = {},
): void {
	switch (event.type) {
		case "run":
			handlers.onRunId?.(event.runId);
			break;
		case "provider_fallback":
			handlers.onProviderFallback?.(event);
			break;
		case "assistant_delta":
			handlers.onDelta(event.id, event.delta);
			break;
		case "assistant_discard":
			handlers.onDiscard?.();
			break;
		case "session":
			handlers.onSession?.({
				sessionId: event.sessionId,
				viewerUrl: event.viewerUrl,
			});
			break;
		case "tool_call":
			handlers.onToolCall?.({
				id: event.id,
				name: event.name,
				args: event.args,
				step: event.step,
				maxSteps: event.maxSteps,
			});
			break;
		case "tool_result":
			handlers.onToolResult?.({
				id: event.id,
				name: event.name,
				ok: event.ok,
				summary: event.summary,
				...("jev" in event && isJevToolReview(event.jev) ? { jev: event.jev } : {}),
			});
			break;
		case "done":
			handlers.onDone?.({
				message: event.message,
				model: event.model,
				usage: event.usage,
			});
			break;
		case "paused":
			handlers.onPaused?.(event.reason);
			break;
		case "cancelled":
			handlers.onCancelled?.(event.reason);
			break;
		case "input_consumed":
			handlers.onInputConsumed?.(event);
			break;
		case "input_received":
			handlers.onInputReceived?.(event);
			break;
		case "status":
			handlers.onStatus?.(event.status, event.detail);
			break;
		case "error":
			handlers.onError?.(event.error);
			break;
		case "skill":
			handlers.onSkill?.(event);
			break;
		case "skill-proposal":
			handlers.onSkillProposal?.(event);
			break;
		case "bot-proposal":
			handlers.onBotProposal?.(event);
			break;
		case "routine":
			handlers.onRoutine?.(event);
			break;
		case "images":
			handlers.onImages?.(event);
			break;
		case "tool_budget_extended":
			handlers.onToolBudgetExtended?.(event);
			break;
		case "subagent_started":
		case "subagent_tool":
		case "subagent_done":
			handlers.onSubagent?.(event);
			break;
		case "confirm":
			handlers.onConfirm?.(event);
			break;
		case "login":
			handlers.onLogin?.(event);
			break;
		case "file":
			handlers.onFile?.(event);
			break;
		case "agent_pointer":
			handlers.onAgentPointer?.(event);
			break;
		case "dev_session_status":
		case "dev_setup_step":
		case "shell_started":
		case "shell_output":
		case "shell_done":
		case "file_edit":
		case "todo_updated":
		case "dev_pr":
		case "dev_ci":
			handlers.onDevSession?.(event, meta);
			break;
		case "context_compacted":
			handlers.onContextCompacted?.(event, meta);
			break;
		case "context_usage":
			handlers.onContextUsage?.(event, meta);
			break;
		case "dev_timing":
			handlers.onDevTiming?.(event, meta);
			break;
	}
}

export async function runComputerUse(
	request: ComputerUseRequest,
	handlers: ComputerUseHandlers,
): Promise<string | null> {
	const base = getAtlasApiBaseUrl();
	const response = await fetch(`${base}/v1/chat/computer`, {
		method: "POST",
		credentials: "same-origin",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request),
	});

	if (!response.ok) {
		return throwApiError(response);
	}
	if (!response.body) {
		throw new AtlasApiError("Resposta de computer-use vazia", 502);
	}

	const headerRunId = response.headers.get("X-Atlas-Run-Id");
	let runId: string | null =
		headerRunId && headerRunId.trim().length > 0 ? headerRunId.trim() : null;
	if (runId) {
		handlers.onRunId?.(runId);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		const parts = buffer.split("\n\n");
		buffer = parts.pop() ?? "";

		for (const part of parts) {
			const line = part
				.split("\n")
				.map((row) => row.trim())
				.find((row) => row.startsWith("data:"));
			if (!line) continue;

			let event: ComputerUseEvent;
			try {
				event = JSON.parse(line.slice(5).trim()) as ComputerUseEvent;
			} catch {
				continue;
			}

			if (event.type === "run") {
				runId = event.runId;
			}
			dispatchComputerUseEvent(event, handlers);
		}
	}

	return runId;
}

export type CreateAgentRunBody = {
	messages: ChatMessage[];
	attachments?: { artifactId: string }[];
	model?: string;
	conversationId?: string;
	botId?: string;
	sandboxSessionId?: string;
	maxSteps?: number;
	origin?: "chat" | "routine" | "webhook";
	objective?: string;
	/** Cartão de aprovação em que o clique foi feito (o servidor ignora decisão de cartão substituído). */
	decisionConfirmId?: string;
	/**
	 * Chave idempotente do questionário (`questionnaireClientKey`).
	 * Vai no corpo (forward-compat) e no header `Idempotency-Key`.
	 * O `POST /v1/runs` atual ignora `clientKey` no corpo e usa
	 * 1-run-ativo-por-conversa (P2002 -> steer); o header prepara o
	 * contrato sem quebrar o backend.
	 */
	clientKey?: string;
	/**
	 * Run silencioso: não grava o objective como mensagem `user` na conversa.
	 * Para eventos proativos (bot-created, questionnaire).
	 */
	silent?: boolean;
};

export type CreateAgentRunResult = {
	/** `null` quando o bot só reagiu (`status: "reacted"`): a mensagem foi salva e não há run. */
	runId: string | null;
	status: string;
	enqueued?: boolean;
	messageId?: string;
	reaction?: string;
};

/** Reação do usuário a uma fala (uma por mensagem). Devolve as reações atuais da mensagem. */
export async function setMessageReaction(messageId: string, emoji: string): Promise<MessageReaction[]> {
	const body = await atlasFetch<{ reactions: MessageReaction[] }>(`/v1/messages/${encodeURIComponent(messageId)}/reaction`, {
		method: "PUT",
		body: JSON.stringify({ emoji }),
	});
	return body.reactions;
}

export async function clearMessageReaction(messageId: string): Promise<MessageReaction[]> {
	const body = await atlasFetch<{ reactions: MessageReaction[] }>(`/v1/messages/${encodeURIComponent(messageId)}/reaction`, { method: "DELETE" });
	return body.reactions;
}

export async function getMessageReactions(messageId: string): Promise<MessageReaction[]> {
	const body = await atlasFetch<{ reactions: MessageReaction[] }>(`/v1/messages/${encodeURIComponent(messageId)}/reactions`);
	return body.reactions;
}

export async function createAgentRun(
	request: CreateAgentRunBody,
): Promise<CreateAgentRunResult> {
	const { clientKey, ...body } = request;
	return atlasFetch<CreateAgentRunResult>(
		"/v1/runs",
		{
			method: "POST",
			body: JSON.stringify(clientKey ? { ...body, clientKey } : body),
			...(clientKey ? { headers: { "Idempotency-Key": clientKey } } : {}),
		},
	);
}

/**
 * Responde um questionário SEM balão user: marca o card como submitted
 * (persistindo as respostas) e cria um run silencioso para o bot reagir.
 */
export async function submitQuestionnaire(request: {
	conversationId: string;
	questionnaireId: string;
	botId?: string;
	answers: Record<string, string | string[]>;
	clientKey?: string;
}): Promise<{ runId: string; status: string; enqueued?: boolean }> {
	return atlasFetch<{ runId: string; status: string; enqueued?: boolean }>(
		"/v1/questionnaire/submit",
		{
			method: "POST",
			body: JSON.stringify(request),
		},
	);
}

/**
 * Responde, da conversa de quem chamou o bot, o card que ele deixou esperando o usuário
 * (aprovar/recusar/questionário). Mesmo efeito de responder na conversa do bot; já
 * resolvido (inclusive lá) devolve `already` sem aplicar de novo.
 */
export async function answerBotPending(request: {
	conversationId: string;
	cardId: string;
	decision: "approve" | "reject" | "answer";
	feedback?: string;
	answers?: Record<string, string | string[]>;
}): Promise<{ status: "applied" | "already"; runId?: string }> {
	return atlasFetch<{ status: "applied" | "already"; runId?: string }>("/v1/bot-pending/answer", {
		method: "POST",
		body: JSON.stringify(request),
	});
}

/**
 * Resolve proposta de perfil (gate humano): approved aplica o PATCH no bot
 * + marca approved; rejected só marca rejected. Sem balão na thread.
 */
export async function resolveBotProfileProposal(request: {
	conversationId: string;
	proposalId: string;
	decision: "approved" | "rejected";
}): Promise<{ ok: boolean; status: string; fields: string[] }> {
	return atlasFetch<{ ok: boolean; status: string; fields: string[] }>(
		"/v1/cards/bot-profile/resolve",
		{
			method: "POST",
			body: JSON.stringify(request),
		},
	);
}

export async function getAgentRun(runId: string): Promise<{
	run: {
		id: string;
		botId?: string | null;
		status: string;
		usageJson?: RunUsage | null;
		resultText: string | null;
		error: string | null;
	};
}> {
	return atlasFetch(`/v1/runs/${encodeURIComponent(runId)}`);
}

export async function listAgentRunEvents(
	runId: string,
	after = 0,
): Promise<{ events: RunEventRecord[] }> {
	return atlasFetch(
		`/v1/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(String(after))}`,
	);
}

export async function listConversationRuns(
	conversationId: string,
): Promise<{ runs: { id: string; status: string }[] }> {
	return atlasFetch(
		`/v1/conversations/${encodeURIComponent(conversationId)}/runs?active=0`,
	);
}

export async function listActiveConversationRuns(
	conversationId: string,
): Promise<{ runs: { id: string; status: string }[] }> {
	return atlasFetch(
		`/v1/conversations/${encodeURIComponent(conversationId)}/runs?active=1`,
	);
}

export async function getLatestCompletedRun(
	conversationId: string,
): Promise<{
	run: {
		id: string;
		status: string;
		objective: string;
		resultText: string | null;
		error: string | null;
	} | null;
}> {
	return atlasFetch(
		`/v1/conversations/${encodeURIComponent(conversationId)}/runs/latest-completed`,
	);
}

export async function cancelAgentRun(runId: string): Promise<void> {
	await atlasFetch(`/v1/runs/${encodeURIComponent(runId)}/cancel`, {
		method: "POST",
	});
}

export async function pauseAgentRun(runId: string): Promise<{
	run: { id: string; status: string };
}> {
	return atlasFetch(`/v1/runs/${encodeURIComponent(runId)}/pause`, {
		method: "POST",
	});
}

export async function resumeAgentRun(runId: string, options: { via?: "vault" | "code"; code?: string } = {}): Promise<{
	run: { id: string; status: string };
	enqueued: boolean;
}> {
	return atlasFetch(`/v1/runs/${encodeURIComponent(runId)}/resume`, {
		method: "POST",
		...(options.via ? { body: JSON.stringify({ via: options.via, ...(options.code ? { code: options.code } : {}) }) } : {}),
	});
}

export function buildRunInputBody(input: {
	content: string;
	mode?: RunInputMode;
	attachments?: { artifactId: string }[];
	clientKey?: string;
}): Record<string, unknown> {
	const body: Record<string, unknown> = {
		content: input.content,
	};
	if (input.mode !== undefined) {
		body.mode = input.mode;
	}
	if (input.attachments && input.attachments.length > 0) {
		body.attachments = input.attachments;
	}
	if (input.clientKey !== undefined) {
		body.clientKey = input.clientKey;
	}
	return body;
}

export async function createRunInput(
	runId: string,
	body: {
		content: string;
		attachments?: { artifactId: string }[];
		mode?: RunInputMode;
		clientKey?: string;
	},
): Promise<{
	input: {
		id: string;
		seq: number;
		mode: string;
		status: string;
		content: string;
	};
}> {
	return atlasFetch(`/v1/runs/${encodeURIComponent(runId)}/inputs`, {
		method: "POST",
		body: JSON.stringify(buildRunInputBody(body)),
	});
}

/** Assina eventos persistidos de um run (SSE reconectável com `after` / Last-Event-ID). */

/** Assina eventos persistidos de um run (SSE reconectável com `after` / Last-Event-ID). */
export async function streamAgentRun(
	runId: string,
	handlers: ComputerUseHandlers,
	options?: { after?: number; signal?: AbortSignal },
): Promise<void> {
	// No Android o PWA em segundo plano tem a conexão congelada/morta sem erro: o read() nunca resolve.
	// Watchdog (silêncio > STREAM_IDLE_MS; o servidor manda keepalive) e "voltei ao app" derrubam a conexão atual
	// e o loop reconecta a partir do cursor.
	const control: { conn: AbortController | null; lastActivity: number } = { conn: null, lastActivity: Date.now() };
	const watchdog = setInterval(() => {
		if (control.conn && isStreamIdle(control.lastActivity, Date.now())) control.conn.abort();
	}, 5_000);
	const unsubscribe = subscribeAppResume(() => control.conn?.abort());
	try {
		await streamAgentRunLoop(runId, handlers, options, control);
	} finally {
		clearInterval(watchdog);
		unsubscribe();
	}
}

async function streamAgentRunLoop(
	runId: string,
	handlers: ComputerUseHandlers,
	options: { after?: number; signal?: AbortSignal } | undefined,
	control: { conn: AbortController | null; lastActivity: number },
): Promise<void> {
	const base = getAtlasApiBaseUrl();
	handlers.onRunId?.(runId);

	const replay = createSseReplayGuard(options?.after ?? getStoredSseCursor(runId));
	let attempt = 0;

	while (!options?.signal?.aborted) {
		const conn = new AbortController();
		control.conn = conn;
		control.lastActivity = Date.now();
		const outer = options?.signal;
		const relayAbort = () => conn.abort();
		outer?.addEventListener("abort", relayAbort, { once: true });
		let response: Response;
		try {
			response = await fetch(
				`${base}/v1/runs/${encodeURIComponent(runId)}/stream?after=${replay.cursor}`,
				{
					method: "GET",
					credentials: "same-origin",
					headers: {
						Accept: "text/event-stream",
						...(replay.cursor > 0 ? { "Last-Event-ID": String(replay.cursor) } : {}),
					},
					signal: conn.signal,
				},
			);
		} catch (error) {
			outer?.removeEventListener("abort", relayAbort);
			if (outer?.aborted) return;
			if (conn.signal.aborted) continue; // watchdog / voltou ao app: tenta de novo já
			throw error;
		}

		if (!response.ok) {
			return throwApiError(response);
		}
		if (!response.body) {
			throw new AtlasApiError("Stream de run vazio", 502);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				if (options?.signal?.aborted) {
					await reader.cancel().catch(() => undefined);
					return;
				}

				let chunk: ReadableStreamReadResult<Uint8Array>;
				try {
					chunk = await reader.read();
				} catch (error) {
					if (options?.signal?.aborted) return;
					if (conn.signal.aborted) break;
					const message =
						error instanceof Error ? error.message.toLowerCase() : "";
					if (
						message.includes("error in input stream") ||
						message.includes("aborted")
					) {
						break;
					}
					throw error;
				}

				const { done, value } = chunk;
				if (done) {
					break;
				}
				control.lastActivity = Date.now();
				attempt = 0;
				buffer += decoder.decode(value, { stream: true });

				const parts = buffer.split("\n\n");
				buffer = parts.pop() ?? "";

				for (const part of parts) {
					// Trocou de conversa no meio do chunk: o evento não pode cair no estado de outra conversa.
					if (options?.signal?.aborted) return;
					const parsed = parseSseBlock(part);
					if (!replay.accept(parsed.id)) continue;
					if (parsed.id !== undefined) setStoredSseCursor(runId, parsed.id);
					if (!parsed.event) continue;
					dispatchComputerUseEvent(parsed.event, handlers, { seq: parsed.id, runId });
					if (
						parsed.event.type === "done" ||
						parsed.event.type === "paused" ||
						parsed.event.type === "cancelled" ||
						parsed.event.type === "error" ||
						(parsed.event.type === "status" &&
							parsed.event.status === "budget_exhausted")
					) {
						return;
					}
				}
			}
		} finally {
			outer?.removeEventListener("abort", relayAbort);
			reader.releaseLock();
		}

		const snapshot = await getAgentRun(runId).catch(() => null);
		const status = snapshot?.run.status;
		if (
			status === "completed" ||
			status === "failed" ||
			status === "cancelled" ||
			status === "budget_exhausted" ||
			status === "paused"
		) {
			return;
		}
		if (!snapshot && attempt >= 8) {
			throw new AtlasApiError(
				"Não consegui acompanhar o run (API/Redis indisponível).",
				503,
			);
		}

		if (options?.signal?.aborted) return;
		attempt += 1;
		const delay = Math.min(8_000, 400 * 2 ** Math.min(attempt, 4));
		await new Promise((resolve) => setTimeout(resolve, delay));
	}
}

// ---------------------------------------------------------------------------
// Gatilho GitHub v2 (autocomplete do editor de rotinas) — reaproveita a
// conexão GitHub do Marketplace; nunca expõe token ao client.
// ---------------------------------------------------------------------------

export type GithubStatus = {
	connected: boolean;
	login?: string;
	source?: string;
};

export async function getGithubStatus(): Promise<GithubStatus> {
	return atlasFetch<GithubStatus>("/v1/github/status");
}

export type GithubRepoOption = {
	fullName: string;
	private: boolean;
	defaultBranch: string;
	pushedAt: string;
};

export async function listGithubRepos(query?: string): Promise<GithubRepoOption[]> {
	const q = query?.trim();
	const path = q ? `/v1/github/repos?q=${encodeURIComponent(q)}` : "/v1/github/repos";
	const body = await atlasFetch<{ repos: GithubRepoOption[] }>(path);
	return body.repos;
}

export type GithubPullOption = {
	number: number;
	title: string;
	author?: string;
	head: string;
	base: string;
	url: string;
};

/** `repo` = "owner/name". */
export async function listGithubPulls(repo: string): Promise<GithubPullOption[]> {
	const [owner, name] = repo.split("/");
	if (!owner || !name) return [];
	const body = await atlasFetch<{ pulls: GithubPullOption[] }>(
		`/v1/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`,
	);
	return body.pulls;
}

export type GithubBranchOption = { name: string };

/** `repo` = "owner/name". */
export async function listGithubBranches(repo: string): Promise<GithubBranchOption[]> {
	const [owner, name] = repo.split("/");
	if (!owner || !name) return [];
	const body = await atlasFetch<{ branches: GithubBranchOption[] }>(
		`/v1/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`,
	);
	return body.branches;
}

export async function listRoutines(botId: string): Promise<RoutineRecord[]> {
	const body = await atlasFetch<{ routines: RoutineRecord[] }>(
		`/v1/bots/${encodeURIComponent(botId)}/routines`,
	);
	return body.routines;
}

export async function listBotRoutineRuns(
	botId: string,
): Promise<RoutineRunListItem[]> {
	const body = await atlasFetch<{ runs: RoutineRunListItem[] }>(
		`/v1/bots/${encodeURIComponent(botId)}/routine-runs`,
	);
	return body.runs;
}

type RoutineHookResponse = { hookKey: string; url: string; secret?: string; setupUrl?: string };

export async function createRoutine(
	botId: string,
	input: Omit<CreateRoutineInput, "botId">,
): Promise<{
	routine: RoutineRecord;
	hook?: RoutineHookResponse;
	github?: RoutineGithubTriggerView;
}> {
	return atlasFetch<{
		routine: RoutineRecord;
		hook?: RoutineHookResponse;
		github?: RoutineGithubTriggerView;
	}>(`/v1/bots/${encodeURIComponent(botId)}/routines`, {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export async function updateRoutine(
	botId: string,
	routineId: string,
	patch: UpdateRoutineInput,
): Promise<{ routine: RoutineRecord; hook?: RoutineHookResponse; github?: RoutineGithubTriggerView }> {
	return atlasFetch<{ routine: RoutineRecord; hook?: RoutineHookResponse; github?: RoutineGithubTriggerView }>(
		`/v1/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(routineId)}`,
		{ method: "PATCH", body: JSON.stringify(patch) },
	);
}

export async function rotateRoutineSecret(
	botId: string,
	routineId: string,
): Promise<{
	routine: RoutineRecord;
	hook?: RoutineHookResponse;
}> {
	return atlasFetch(
		`/v1/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(routineId)}/rotate-secret`,
		{ method: "POST" },
	);
}

export async function deleteRoutine(
	botId: string,
	routineId: string,
): Promise<void> {
	await atlasFetch<{ ok: boolean }>(
		`/v1/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(routineId)}`,
		{ method: "DELETE" },
	);
}

export async function runRoutineNow(
	botId: string,
	routineId: string,
): Promise<void> {
	await atlasFetch<{ ok: boolean }>(
		`/v1/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(routineId)}/run`,
		{ method: "POST" },
	);
}

export async function listRoutineRuns(
	botId: string,
	routineId: string,
): Promise<RoutineRunRecord[]> {
	const body = await atlasFetch<{ runs: RoutineRunRecord[] }>(
		`/v1/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(routineId)}/runs`,
	);
	return body.runs;
}

/** Prévia de um arquivo gerado (docx em HTML, planilha, texto/código, URL do PDF). */
export async function fetchFilePreview(artifactId: string): Promise<FilePreview> {
	return atlasFetch<FilePreview>(filePreviewPath(artifactId));
}

// SIWC: estado público apenas; tokens nunca são enviados ao navegador.
export function listProviders(signal?: AbortSignal): Promise<ListProvidersResponse> {
	return atlasFetch("/v1/providers", { signal });
}
export function connectChatgptProvider(): Promise<{ authorizeUrl: string }> {
	return atlasFetch("/v1/providers/chatgpt/connect", { method: "POST", body: "{}" });
}
export type ChatgptDeviceStart = { userCode: string; verificationUrl: string; expiresAt: string; intervalSeconds: number };
export type ChatgptDevicePoll =
	| { status: "pending"; expiresAt: string; intervalSeconds: number }
	| { status: "connected" | "expired" | "none" };
/** Login por código (sem redirect): funciona com o Atlas em servidor remoto. */
export function startChatgptDeviceLogin(): Promise<ChatgptDeviceStart> {
	return atlasFetch("/v1/providers/chatgpt/device/start", { method: "POST", body: "{}" });
}
export function pollChatgptDeviceLogin(): Promise<ChatgptDevicePoll> {
	return atlasFetch("/v1/providers/chatgpt/device/poll", { method: "POST", body: "{}" });
}
export function disconnectChatgptProvider(): Promise<{ ok: boolean; revocationConfirmed: boolean }> {
	return atlasFetch("/v1/providers/chatgpt", { method: "DELETE" });
}
export function listChatgptModels(selected?: string, signal?: AbortSignal): Promise<ProviderModelsResponse> {
	const query = selected ? `?${new URLSearchParams({ selected })}` : "";
	return atlasFetch(`/v1/providers/chatgpt/models${query}`, { signal });
}

// Chaves de API próprias (Anthropic, OpenCode Go): a chave só vai no PUT e nunca volta.
export type ProviderKeysResponse = { providers: ApiKeyProviderStatus[]; vaultReady: boolean };
export function listProviderKeys(signal?: AbortSignal): Promise<ProviderKeysResponse> {
	return atlasFetch("/v1/provider-keys", { signal });
}
export function saveProviderKey(provider: ApiKeyProvider, apiKey: string): Promise<{ status: ApiKeyProviderStatus }> {
	return atlasFetch(`/v1/provider-keys/${provider}`, { method: "PUT", body: JSON.stringify({ apiKey }) });
}
export function testProviderKey(provider: ApiKeyProvider): Promise<{ status: ApiKeyProviderStatus }> {
	return atlasFetch(`/v1/provider-keys/${provider}/test`, { method: "POST", body: "{}" });
}
export function removeProviderKey(provider: ApiKeyProvider): Promise<{ ok: boolean }> {
	return atlasFetch(`/v1/provider-keys/${provider}`, { method: "DELETE" });
}
export function listProviderKeyModels(provider: ApiKeyProvider, signal?: AbortSignal): Promise<ProviderModelsResponse> {
	return atlasFetch(`/v1/provider-keys/${provider}/models`, { signal });
}

/** Uso da conta no período (`GET /v1/usage`): totais, por bot e por modelo. `tz` = fuso IANA do navegador. */
export async function getUsage(period: UsagePeriod, tz: string): Promise<UsageResponse> {
	const query = new URLSearchParams({ period, tz });
	return atlasFetch<UsageResponse>(`/v1/usage?${query.toString()}`);
}

// --- Habilidades (skills em Markdown, /v1/skills) ---

export type SkillStatusView = "active" | "draft";
export type SkillCreatorView = "user" | "agent";

/** Skill como a API devolve (datas em ISO); a lista vem sem `body`. */
export type SkillDocView = {
	id: string;
	botId: string | null;
	name: string;
	description: string;
	tools: string[];
	enabled: boolean;
	createdBy: SkillCreatorView;
	status: SkillStatusView;
	revision: number;
	createdAt: string;
	updatedAt: string;
	body?: string;
	/** Veio do marketplace? `edited`: o conteúdo atual difere do instalado. */
	source?: { kind: "catalog"; slug: string; version: string; edited: boolean } | null;
};

/** Skill de fábrica (somente leitura, igual para todos). */
export type BuiltinSkillView = {
	slug: string;
	name: string;
	description: string;
	groups: string[];
	version: number;
	body: string;
};

export async function listBuiltinSkills(): Promise<BuiltinSkillView[]> {
	const body = await atlasFetch<{ skills: BuiltinSkillView[] }>("/v1/skills/builtin");
	return body.skills;
}

export type SkillWriteInput = {
	name: string;
	description: string;
	body: string;
	tools?: string[];
	/** Só na criação: o escopo não muda depois. */
	botId?: string | null;
};

export async function listSkills(): Promise<SkillDocView[]> {
	const body = await atlasFetch<{ skills: SkillDocView[] }>("/v1/skills");
	return body.skills;
}

export async function getSkill(id: string): Promise<SkillDocView> {
	const body = await atlasFetch<{ skill: SkillDocView }>(`/v1/skills/${encodeURIComponent(id)}`);
	return body.skill;
}

export async function createSkill(input: SkillWriteInput): Promise<SkillDocView> {
	const body = await atlasFetch<{ skill: SkillDocView }>("/v1/skills", {
		method: "POST",
		body: JSON.stringify(input),
	});
	return body.skill;
}

/** `revision` ativa a trava otimista: edição sobre versão velha volta 409. */
export async function updateSkill(
	id: string,
	patch: Partial<Omit<SkillWriteInput, "botId">> & {
		enabled?: boolean;
		status?: SkillStatusView;
		revision?: number;
	},
): Promise<SkillDocView> {
	const body = await atlasFetch<{ skill: SkillDocView }>(`/v1/skills/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: JSON.stringify(patch),
	});
	return body.skill;
}

export async function deleteSkill(id: string): Promise<void> {
	await atlasFetch<{ ok: boolean }>(`/v1/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Conteúdo de terceiros: o servidor cria como rascunho desligado. */
export async function importSkillMarkdown(markdown: string, botId?: string | null): Promise<SkillDocView> {
	const query = botId ? `?botId=${encodeURIComponent(botId)}` : "";
	const body = await atlasFetch<{ skill: SkillDocView }>(`/v1/skills/import${query}`, {
		method: "POST",
		headers: { "Content-Type": "text/markdown; charset=utf-8" },
		body: markdown,
	});
	return body.skill;
}

/** Apaga em lote os RASCUNHOS do usuário (escopo opcional) e devolve quantos foram. */
export async function deleteSkillDrafts(scope: { botId?: string; account?: boolean } = {}): Promise<number> {
	const query = scope.botId ? `?botId=${encodeURIComponent(scope.botId)}` : scope.account ? "?scope=account" : "";
	const body = await atlasFetch<{ ok: boolean; deleted: number }>(`/v1/skills/delete-drafts${query}`, { method: "POST" });
	return body.deleted;
}

/**
 * Resolve a proposta de skill do agente (gate humano). `markdown` é o documento
 * revisado em "Editar antes" (só criar/editar). Erros: 404 (não existe/já
 * resolvida), 409 (nome repetido/revisão velha), 422 (limite), 400 (inválido).
 */
export async function resolveSkillProposal(request: {
	conversationId: string;
	proposalId: string;
	decision: "approved" | "rejected";
	markdown?: string;
}): Promise<{ ok: boolean; status: "approved" | "rejected"; action: string; name: string }> {
	return atlasFetch("/v1/cards/skill-proposal/resolve", { method: "POST", body: JSON.stringify(request) });
}

/**
 * Resolve a proposta de novo agente (gate humano). `edits` traz o nome/papel revisados
 * no card. Aprovar de novo devolve o mesmo resultado (`unchanged`), sem criar outro bot.
 */
export async function resolveBotProposal(request: {
	conversationId: string;
	proposalId: string;
	decision: "approved" | "rejected";
	edits?: { name?: string; description?: string };
}): Promise<{
	ok: boolean;
	status: "approved" | "rejected";
	name: string;
	botId: string | null;
	unchanged: boolean;
	confirmation?: { id: string; text: string };
	warnings?: string[];
}> {
	return atlasFetch("/v1/cards/bot-proposal/resolve", { method: "POST", body: JSON.stringify(request) });
}

/** Texto do `.md` exportado (frontmatter + corpo). */
export async function exportSkillMarkdown(id: string): Promise<string> {
	const response = await fetch(`${getAtlasApiBaseUrl()}/v1/skills/${encodeURIComponent(id)}/export`, {
		credentials: "same-origin",
	});
	if (!response.ok) return throwApiError(response);
	return response.text();
}

// --- Composio (opcional, chave própria do usuário; /v1/composio) ---

export type ComposioToolkitsPage = ComposioToolkitsPageView;

export function getComposioStatus(): Promise<ComposioStatusView> {
	return atlasFetch("/v1/composio/status");
}
export function saveComposioKey(apiKey: string): Promise<ComposioStatusView> {
	return atlasFetch("/v1/composio/key", { method: "PUT", body: JSON.stringify({ apiKey }) });
}
export function removeComposioKey(): Promise<void> {
	return atlasFetch("/v1/composio/key", { method: "DELETE" });
}
export function listComposioToolkits(
	input: { search?: string; cursor?: string | null; category?: string; limit?: number } = {},
	signal?: AbortSignal,
): Promise<ComposioToolkitsPage> {
	const query = new URLSearchParams();
	if (input.search?.trim()) query.set("search", input.search.trim());
	if (input.cursor) query.set("cursor", input.cursor);
	if (input.category) query.set("category", input.category);
	if (input.limit) query.set("limit", String(input.limit));
	const text = query.toString();
	return atlasFetch(`/v1/composio/toolkits${text ? `?${text}` : ""}`, { signal });
}
export async function listComposioCategories(): Promise<ComposioCategoryView[]> {
	return (await atlasFetch<{ categories: ComposioCategoryView[] }>("/v1/composio/categories")).categories;
}
/** `redirectUrl` = abrir o login; `enabled` = app sem login, já ativado (sem popup). */
export type ComposioConnectResult = { redirectUrl: string } | { enabled: true; toolCount: number };
export function startComposioConnect(toolkit: string): Promise<ComposioConnectResult> {
	return atlasFetch("/v1/composio/connect", { method: "POST", body: JSON.stringify({ toolkit }) });
}
export async function listComposioConnections(): Promise<ComposioConnectedAppView[]> {
	return (await atlasFetch<{ connections: ComposioConnectedAppView[] }>("/v1/composio/connections")).connections;
}
export function disconnectComposioApp(id: string): Promise<void> {
	return atlasFetch(`/v1/composio/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Clique no card de rotina que o bot propôs: Sugerir (accept = criar) ou Automático (accept = manter, decline = desfazer). */
export async function resolveRoutineProposal(request: {
	messageId: string;
	decision: "accept" | "decline";
}): Promise<{ ok: boolean; status: "pending" | "accepted" | "declined"; mode: "suggest" | "auto"; routineId?: string; unchanged?: boolean }> {
	return atlasFetch("/v1/cards/routine-proposal/resolve", { method: "POST", body: JSON.stringify(request) });
}

/** Lembrete agendado pelo bot principal (modo proativo). */
export type BotFollowup = {
	id: string;
	note: string;
	kind: "reminder" | "check";
	/** Próximo aviso pendente. */
	dueAt: string;
	source: "chat" | "reflection";
	/** Avisos do lembrete (sempre ao menos um); `firedAt` = já saiu. */
	stages?: Array<{ at: string; firedAt?: string | null }>;
};

export async function listBotFollowups(botId: string): Promise<BotFollowup[]> {
	const body = await atlasFetch<{ followups: BotFollowup[] }>(`/v1/bots/${encodeURIComponent(botId)}/followups`);
	return body.followups;
}

export type RescheduleFollowupResult = { followup: BotFollowup; movedForQuietHours: boolean };

/** `when`: horário de parede no fuso da conta (`YYYY-MM-DDTHH:mm`) ou texto como "amanhã 9h". */
export async function rescheduleBotFollowup(botId: string, followupId: string, when: string, stage?: number): Promise<RescheduleFollowupResult> {
	const body = await atlasFetch<RescheduleFollowupResult & { ok: boolean }>(
		`/v1/bots/${encodeURIComponent(botId)}/followups/${encodeURIComponent(followupId)}`,
		{ method: "PATCH", body: JSON.stringify({ when, ...(stage ? { stage } : {}) }) },
	);
	return { followup: body.followup, movedForQuietHours: body.movedForQuietHours === true };
}

export async function cancelBotFollowup(botId: string, followupId: string): Promise<void> {
	await atlasFetch<{ ok: boolean }>(
		`/v1/bots/${encodeURIComponent(botId)}/followups/${encodeURIComponent(followupId)}`,
		{ method: "DELETE" },
	);
}

// ----- Ambientes de código por repositório -----

export type DevEnvironmentView = {
	id: string;
	repo: string;
	installCommand: string | null;
	startCommand: string | null;
	/** Comando de teste rápido (opcional). */
	testCommand: string | null;
	tier: import("@workspace/shared").DevEnvTier;
	network: import("@workspace/shared").DevEnvNetwork;
	/** Domínios do usuário (a lista padrão vem de `DEFAULT_EGRESS_ALLOWLIST`). */
	allowlist: string[];
	/** `null` = padrão da conta. */
	approvalMode: import("@workspace/shared").DevApprovalMode | null;
	/** Prefixos de comando liberados no modo "Lista liberada". */
	commandAllowlist: string[];
	/** Só os nomes; o valor nunca volta do servidor. */
	secrets: { name: string; set: true }[];
	/** `auto` = detectado/aprendido pelo agente sem o usuário preencher nada. */
	source?: "manual" | "auto";
	/** Campos que o usuário editou (o agente não os sobrescreve). */
	userEditedFields?: string[];
	secretsUnreadable?: boolean;
	createdAt: string;
	updatedAt: string;
};

export type DevEnvironmentInput = {
	repo?: string;
	installCommand?: string | null;
	startCommand?: string | null;
	testCommand?: string | null;
	tier?: DevEnvironmentView["tier"];
	network?: DevEnvironmentView["network"];
	allowlist?: string[];
	approvalMode?: DevEnvironmentView["approvalMode"];
	commandAllowlist?: string[];
};

export async function listDevEnvironments(): Promise<{ environments: DevEnvironmentView[]; secretsAvailable: boolean; devSessionsEnabled?: boolean; defaultApprovalMode?: import("@workspace/shared").DevApprovalMode | null; verifierEnabled?: boolean }> {
	return atlasFetch("/v1/dev-environments");
}

/** Padrão da conta para aprovação de comandos (`null` = Lista liberada). */
export async function setDevApprovalDefault(approvalMode: import("@workspace/shared").DevApprovalMode | null): Promise<void> {
	await atlasFetch("/v1/dev-environments-defaults", { method: "PUT", body: JSON.stringify({ approvalMode }) });
}

/** Verificador inteligente da conta (liga/desliga; não mexe no modo de aprovação). */
export async function setDevVerifier(verifier: boolean): Promise<void> {
	await atlasFetch("/v1/dev-environments-defaults", { method: "PUT", body: JSON.stringify({ verifier }) });
}

export async function createDevEnvironment(input: DevEnvironmentInput): Promise<DevEnvironmentView> {
	return atlasFetch("/v1/dev-environments", { method: "POST", body: JSON.stringify(input) });
}

export async function updateDevEnvironment(id: string, input: DevEnvironmentInput): Promise<DevEnvironmentView> {
	return atlasFetch(`/v1/dev-environments/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export async function deleteDevEnvironment(id: string): Promise<void> {
	await atlasFetch(`/v1/dev-environments/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Apaga as dependências guardadas do ambiente; a próxima sessão instala do zero. */
export async function clearDevEnvironmentCache(id: string): Promise<{ ok: true; cleared: boolean }> {
	return atlasFetch(`/v1/dev-environments/${encodeURIComponent(id)}/cache`, { method: "DELETE" });
}

export async function setDevEnvironmentSecret(id: string, name: string, value: string): Promise<DevEnvironmentView> {
	return atlasFetch(`/v1/dev-environments/${encodeURIComponent(id)}/secrets/${encodeURIComponent(name)}`, {
		method: "PUT",
		body: JSON.stringify({ value }),
	});
}

/** Vários segredos de uma vez (write-only). */
export async function setDevEnvironmentSecrets(id: string, entries: { name: string; value: string }[]): Promise<DevEnvironmentView> {
	return atlasFetch(`/v1/dev-environments/${encodeURIComponent(id)}/secrets`, {
		method: "PUT",
		body: JSON.stringify({ entries }),
	});
}

export type DevEnvSuggestionView = Pick<import("@workspace/shared").DevEnvSuggestion, "detected"> & Partial<Omit<import("@workspace/shared").DevEnvSuggestion, "detected">> & { reason?: string };

/** Sugestões de ambiente lidas do repositório; sem acesso ao GitHub volta `detected: false`. */
export async function detectDevEnvironmentFromRepo(repo: string): Promise<DevEnvSuggestionView> {
	return atlasFetch(`/v1/dev-environments/detect?repo=${encodeURIComponent(repo)}`);
}

export async function deleteDevEnvironmentSecret(id: string, name: string): Promise<DevEnvironmentView> {
	return atlasFetch(`/v1/dev-environments/${encodeURIComponent(id)}/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// GitHub App da instância (criação pelo dono + instalação por usuário).
// Nunca expõe segredo ao client.
// ---------------------------------------------------------------------------

export type GithubAppInstallation = {
	id: string;
	accountLogin: string;
	accountType: string;
	repositorySelection: "all" | "selected";
	repoCount: number | null;
	repos: Array<{ fullName: string; private: boolean }>;
	suspended: boolean;
	manageUrl: string;
	createdAt: string;
};

export type GithubAppStatus = {
	configured: boolean;
	isOwner: boolean;
	source: "env" | "db" | null;
	slug: string | null;
	name: string | null;
	appUrl: string | null;
	canVerifyInstall: boolean;
	webhookUrl: string;
	defaultName: string;
	signature: boolean;
	signatureText: string | null;
	/** Permissões de escrita que o app ainda não tem no GitHub (o usuário precisa aceitar a mudança). */
	missingWritePermissions: string[];
	permissionsUrl: string | null;
	installations: GithubAppInstallation[];
};

export type GithubWriteSettingsPatch = { signature?: boolean; signatureText?: string | null };

export const GITHUB_APP_INSTALL_PATH = "/v1/github-app/install";
export const GITHUB_APP_MANIFEST_START_PATH = "/v1/github-app/manifest/start";

export async function getGithubAppStatus(): Promise<GithubAppStatus> {
	return atlasFetch<GithubAppStatus>("/v1/github-app/status");
}

export async function saveGithubWriteSettings(patch: GithubWriteSettingsPatch): Promise<{ signature: boolean; signatureText: string | null }> {
	return atlasFetch("/v1/github-app/write-settings", { method: "PUT", body: JSON.stringify(patch) });
}

export async function refreshGithubAppInstallation(id: string): Promise<{ installation?: GithubAppInstallation | null; removed?: boolean }> {
	return atlasFetch(`/v1/github-app/installations/${encodeURIComponent(id)}/refresh`, { method: "POST" });
}

export async function removeGithubAppInstallation(id: string): Promise<void> {
	await atlasFetch(`/v1/github-app/installations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function removeGithubApp(): Promise<void> {
	await atlasFetch("/v1/github-app", { method: "DELETE" });
}

export type ReflectionStatusView = {
	settings: { enabled: boolean; time: string };
	/** Memória do bot principal: limite em vigor e caracteres usados (null = não lido). */
	memory: { limit: number; used: number | null };
	timezone: string;
	hasPrimary: boolean;
	/** Há uma reflexão na fila ou rodando. */
	active: boolean;
	last: {
		id: string;
		trigger: "scheduled" | "manual";
		status: "queued" | "running" | "done" | "skipped" | "failed";
		summary: string | null;
		important: boolean;
		detail: string | null;
		finishedAt: string | null;
		startedAt: string | null;
		changeCount: number;
	} | null;
};

/** Estado da reflexão diária do orquestrador (última execução e se há uma em andamento). */
export async function getReflectionStatus(): Promise<ReflectionStatusView> {
	return atlasFetch<ReflectionStatusView>("/v1/reflection");
}

/** "Refletir agora": entra na fila do worker. */
export async function runReflectionNow(): Promise<{ ok: boolean; id: string }> {
	return atlasFetch<{ ok: boolean; id: string }>("/v1/reflection/run", { method: "POST", body: "{}" });
}

// ----- Cofre (segredos e logins de sites) -----

export type VaultItemKind = "secret" | "login";

export type VaultItemView = {
	id: string;
	kind: VaultItemKind;
	name: string;
	label: string;
	description: string;
	siteUrl: string | null;
	domain: string | null;
	username: string | null;
	createdAt: string;
	updatedAt: string;
	lastUsedAt: string | null;
	alwaysBots: string[];
};

export type VaultExtraField = { name: string; value: string; secret: boolean };

export type VaultPayloadView = {
	value?: string;
	password?: string;
	totp?: string;
	notes?: string;
	extras?: VaultExtraField[];
};

export type VaultAuditEntry = {
	id: string;
	action: string;
	actor: string;
	botId: string | null;
	botName: string | null;
	conversationId: string | null;
	detail: string | null;
	createdAt: string;
};

export type VaultWriteInput = {
	kind?: VaultItemKind;
	name?: string;
	label?: string;
	description?: string;
	siteUrl?: string;
	username?: string;
	value?: string;
	password?: string;
	totp?: string;
	removeTotp?: boolean;
	notes?: string;
	extras?: VaultExtraField[];
};

export async function listVault(): Promise<{ items: VaultItemView[]; available: boolean }> {
	return atlasFetch("/v1/vault");
}

export async function createVaultItem(input: VaultWriteInput): Promise<VaultItemView> {
	return (await atlasFetch<{ item: VaultItemView }>("/v1/vault", { method: "POST", body: JSON.stringify(input) })).item;
}

export async function updateVaultItem(id: string, input: VaultWriteInput): Promise<VaultItemView> {
	return (await atlasFetch<{ item: VaultItemView }>(`/v1/vault/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) })).item;
}

export async function deleteVaultItem(id: string): Promise<void> {
	await atlasFetch<void>(`/v1/vault/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function getVaultItem(id: string): Promise<{ item: VaultItemView; audit: VaultAuditEntry[] }> {
	return atlasFetch(`/v1/vault/${encodeURIComponent(id)}`);
}

/** Revela o conteúdo (a tela confirma antes; fica no histórico do item). */
export async function revealVaultItem(id: string, copy?: string): Promise<VaultPayloadView> {
	return (await atlasFetch<{ payload: VaultPayloadView }>(`/v1/vault/${encodeURIComponent(id)}/reveal`, { method: "POST", body: JSON.stringify({ confirm: true, ...(copy ? { purpose: "copy", what: copy } : {}) }) })).payload;
}

export async function recordVaultCopy(id: string, what: string): Promise<void> {
	await atlasFetch<void>(`/v1/vault/${encodeURIComponent(id)}/copy`, { method: "POST", body: JSON.stringify({ what }) }).catch(() => undefined);
}

export async function getVaultTotp(id: string): Promise<{ code: string; expiresInSec: number }> {
	return atlasFetch(`/v1/vault/${encodeURIComponent(id)}/totp`);
}

export async function previewTotp(input: string): Promise<{ ok: boolean; code?: string; expiresInSec?: number; error?: string }> {
	try {
		return await atlasFetch("/v1/vault/totp/preview", { method: "POST", body: JSON.stringify({ input }) });
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : "Chave 2FA inválida" };
	}
}

/** Grava segredos simples direto no cofre (cartão do bot e aviso do composer). `unique` renomeia se o nome já existe. */
export async function saveVaultSecrets(
	entries: { name: string; value: string; description?: string }[],
	mode: "upsert" | "unique" = "upsert",
): Promise<{ saved: { name: string; id: string }[] }> {
	return atlasFetch("/v1/vault/secrets", { method: "POST", body: JSON.stringify({ entries, mode }) });
}

// --- Marketplace de skills e agentes (/v1/catalog) ---

export type CatalogInstallView = {
	id: string;
	botId: string | null;
	name: string;
	version: string;
	edited: boolean;
	updateAvailable: boolean;
};

export type CatalogSkillItem = CatalogSkillEntry & { installs: CatalogInstallView[] };
export type CatalogListResponse = { skills: CatalogSkillItem[]; bots: CatalogBotEntry[] };

export type CatalogSkillDetail = {
	entry: CatalogSkillEntry;
	changelog: CatalogChangelogEntry[];
	body: string;
	tools: string[];
	findings: ScanFinding[];
	installs: CatalogInstallView[];
};

export type CatalogBotDetail = {
	entry: CatalogBotEntry;
	bot: CatalogBotTemplate;
	skills: Array<{ slug: string; name: string; description: string; version: string; tools: string[]; blocked: boolean }>;
	connectors: Array<{ id: string; reason?: string; connected: boolean }>;
	findings: ScanFinding[];
};

export async function getCatalog(): Promise<CatalogListResponse> {
	return atlasFetch<CatalogListResponse>("/v1/catalog");
}

export async function getCatalogSkill(slug: string): Promise<CatalogSkillDetail> {
	return atlasFetch<CatalogSkillDetail>(`/v1/catalog/skills/${encodeURIComponent(slug)}`);
}

export async function getCatalogBot(slug: string): Promise<CatalogBotDetail> {
	return atlasFetch<CatalogBotDetail>(`/v1/catalog/bots/${encodeURIComponent(slug)}`);
}

export type CatalogEditedConflict = {
	installedVersion: string;
	catalogVersion: string;
	diff: TextDiff;
};

/** Corpo do 409 `edited` da instalação (cópia editada), ou null para outro erro. */
export function catalogEditedConflict(error: unknown): CatalogEditedConflict | null {
	if (!(error instanceof AtlasApiError) || error.status !== 409) return null;
	const details = error.details as Partial<CatalogEditedConflict> & { code?: string } | undefined;
	return details?.code === "edited" && details.diff ? (details as CatalogEditedConflict) : null;
}

export type CatalogInstallAction = "installed" | "updated" | "kept" | "unchanged";

/** `botId` vazio = conta. `mode` só vale quando a cópia foi editada (update sobrescreve, keep mantém). */
export async function installCatalogSkill(
	slug: string,
	input: { botId?: string | null; mode?: "update" | "keep" } = {},
): Promise<{ action: CatalogInstallAction; id?: string }> {
	return atlasFetch(`/v1/catalog/skills/${encodeURIComponent(slug)}/install`, { method: "POST", body: JSON.stringify(input) });
}

export type CatalogBotInstallInput = {
	name?: string;
	color?: string;
	shape?: string;
	useSuggestedModel?: boolean;
	/** Índices das rotinas sugeridas que o usuário marcou. */
	routines?: number[];
};

export type CatalogBotInstallResult = {
	botId: string;
	name: string;
	installedSkills: string[];
	routines: Array<{ name: string; prompt: string; cron: string }>;
	warnings?: string[];
};

export async function installCatalogBot(slug: string, input: CatalogBotInstallInput): Promise<CatalogBotInstallResult> {
	return atlasFetch(`/v1/catalog/bots/${encodeURIComponent(slug)}/install`, { method: "POST", body: JSON.stringify(input) });
}

export type PublishSkillForm = { version: string; category: string; tags: string[]; notes: string; author: string };
export type PublishedFile = { path: string; content: string };
export type PublishSkillResult =
	| { mode: "pr"; url: string; number: number }
	| { mode: "package"; reason: string; message: string; slug: string; files: PublishedFile[]; newPrUrl: string };

export async function publishSkill(id: string, form: PublishSkillForm): Promise<PublishSkillResult> {
	return atlasFetch(`/v1/skills/${encodeURIComponent(id)}/publish`, { method: "POST", body: JSON.stringify(form) });
}

export async function packageSkill(id: string, form: PublishSkillForm): Promise<{ slug: string; files: PublishedFile[]; newPrUrl: string }> {
	return atlasFetch(`/v1/skills/${encodeURIComponent(id)}/package`, { method: "POST", body: JSON.stringify(form) });
}
