export { COMPUTER_USE_TOOLS, MCP_TOOL_CALLS_DEFAULT, runComputerUse } from "./computer-use.js";
export {
	MCP_READ_TOOL_CALLS_DEFAULT,
	MCP_READ_TOOL_CALLS_HARD_CAP,
	MCP_WRITE_TOOL_CALLS_DEFAULT,
	planToolCallExtension,
} from "./tool-budget.js";
export {
	BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION,
	buildBotConfigEventMessages,
	buildQuestionnaireSubmittedMessages,
	getBotConfigEventExtraSystemMessage,
	hashBotConfigEvent,
	isBotConfigEventObjective,
	parseProposeQuestionnaireArgs,
	parseProposeProfileArgs,
} from "./computer-use.js";
export type {
	ProposeQuestionnaireChoice,
	ProposeQuestionnaireInput,
	ProposeQuestionnaireItem,
	ProposeQuestionnaireProposal,
	ProposeProfilePatch,
} from "./computer-use.js";
export { sanitizeAssistantText } from "./computer-use.js";
export {
	COLLAPSE_MARKER,
	DEFAULT_CONTEXT_LENGTH,
	HYGIENE_HARD_KEEP,
	HYGIENE_HARD_RATIO,
	HYGIENE_SOFT_KEEP,
	HYGIENE_SOFT_RATIO,
	MAX_BINARY_CHARS,
	applyPromptHygiene,
	collapseOldToolGroups,
	estimateMessagesTokens,
	type HygieneOptions,
	type HygieneReport,
} from "./hygiene.js";
export {
	UNEXECUTED_CALL_RESULT,
	alignTranscript,
	attachPendingResult,
	calledToolNames,
	cleanTranscript,
	transcriptTextOf,
} from "./context/transcript.js";
export { contextTranscriptEnabled } from "./context/flag.js";
export type { CompletedToolReplay, RuntimeStepRecord } from "./computer-use.js";
export {
	AgentRunCancelledError,
	AgentRunPausedError,
	AgentRunLoopDetectedError,
	LeaseLostError,
	PermanentRunError,
	TransientRunError,
	BudgetExhaustedError,
	classifyRunError,
	errorFromAbortSignal,
	isControlFlowError,
} from "./errors.js";
export type { ClassifiedRunError } from "./errors.js";
export { describeRunError } from "./user-error.js";
export type { DescribedRunError, UserErrorKind } from "./user-error.js";
export {
	buildRuntimeCheckpoint,
	hydrateLlmMessages,
	parseRuntimeCheckpoint,
	resolveLlmMessagesForModel,
	serializeLlmMessages,
	toolIdempotencyKey,
} from "./checkpoint.js";
export {
	RUN_ABORT_CONSECUTIVE_FAILURES,
	RUN_ABORT_DISTINCT_TOOLS,
	TOOL_FAILURE_BLOCK_AFTER,
	BUDGET_EXTENSION_DEFAULT,
	BUDGET_HARD_CAP,
	BUDGET_SOFT_DEFAULT,
	BUDGET_WALL_DEFAULT_MS,
	addUsage,
	emptyUsage,
	parseBudgetPolicy,
	resolveBudget,
	wallClockAnchors,
} from "./budget.js";
export type { AgentBudget, AgentBudgetPolicy, TokenUsage } from "./budget.js";
export {
	WEB_SEARCH_DEFAULT_LOCALE,
	WEB_SEARCH_DEFAULT_NUM,
	WEB_SEARCH_TIMEOUT_MS,
	WebSearchError,
	buildSearchRequest,
	executeWebSearch,
	isWebSearchAvailable,
	normalizeSearchArgs,
	parseSearchResponse,
	resolveSearchApiKey,
	resolveSearchProvider,
} from "./web-search.js";
export type {
	BuiltSearchRequest,
	ExecuteWebSearchOptions,
	NormalizedSearchArgs,
	SearchFetchFn,
	SearchProvider,
	WebSearchArgs,
	WebSearchErrorCode,
	WebSearchResult,
} from "./web-search.js";
export {
	WEB_EXTRACT_CONCURRENCY,
	WEB_EXTRACT_DEFAULT_MAX_CHARS,
	WEB_EXTRACT_MAX_URLS,
	WEB_EXTRACT_TIMEOUT_MS,
	WEB_EXTRACT_TOTAL_MAX_CHARS,
	WEB_EXTRACT_TRUNCATED_SUFFIX,
	WebExtractError,
	buildExtractRequest,
	buildScrapeRequest,
	executeWebExtract,
	isWebExtractAvailable,
	normalizeExtractMaxChars,
	parseExtractResponse,
	parseScrapeResponse,
	resolveFirecrawlApiKey,
	truncateExtractContent,
} from "./web-extract.js";
export type {
	BuiltExtractRequest,
	ExecuteWebExtractOptions,
	ExtractFetchFn,
	WebExtractArgs,
	WebExtractErrorCode,
	WebExtractItem,
	WebExtractItemError,
} from "./web-extract.js";
export {
	RESEARCH_BUDGET_DEFAULTS,
	mergeResearchBudget,
} from "./research-budget.js";
export type { ResearchBudgetDefaults } from "./research-budget.js";
export {
	McpClientPool,
	MCP_CLIENT_INFO,
	closeSharedMcpPool,
	defaultTransportFactory,
	getSharedMcpPool,
	isRetryableMcpError,
	parseBuiltinGoogleUrl,
	type McpClientConfig,
	type McpTransportFactory,
	type McpTransportKind,
} from "./mcp/client-pool.js";
export { createGoogleMcpServer, type GoogleProduct } from "./mcp/builtin/google.js";
export {
	MCP_CALL_TIMEOUT_MS,
	MCP_RESULT_MAX_CHARS,
	callMcpTool,
	capResultText,
	listMcpTools,
	normalizeCallToolResult,
	type McpCallResult,
} from "./mcp/call.js";
export {
	MCP_MAX_EXPOSED_TOOLS,
	MCP_MAX_TOOLS_JSON_CHARS,
	buildMcpToolset,
	type BuildMcpToolsetOptions,
	type McpIndexConnector,
	type McpIndexTool,
	type McpToolEntry,
	type McpToolset,
	type McpToolsetConnection,
} from "./mcp/registry.js";
export {
	findExactMcpToolMatches,
	listMcpToolNames,
	planMcpActivation,
	searchMcpTools,
	summarizeMcpTools,
	type McpActivationCandidate,
	type McpActivationPlan,
} from "./mcp/activation.js";
export { redactSecrets, sanitizeErrorMessage } from "./mcp/sanitize.js";
export {
	clipForJev,
	decideWithJev,
	jevModeFor,
	parseJevFeatureMode,
	type JevAsk,
	type JevFeature,
	type JevFeatureMode,
	type JevRuntime,
} from "./jev/decide.js";
export {
	createMemoryJudge,
	memoryJudgeFor,
	reviewMemoryEntries,
	MEMORY_GATE_JEV_TIMEOUT_MS,
	type MemoryCleanupDraft,
	type MemoryCleanupEntry,
	type MemoryGateCandidate,
	type MemoryGateDeps,
	type MemoryGateEntry,
	type MemoryGateLayers,
	type MemoryGateVerdict,
	type MemoryJudge,
} from "./memory-gate.js";
export { detectJevIntents, NO_INTENTS, type JevIntents } from "./jev/intent.js";
export { detectReactionOnly, REACTION_QUESTIONS } from "./jev/reaction.js";
export { discoverOpenApiSpec, findSpecLinks, type DiscoveredApi } from "./api-connector/discover.js";
export {
	API_CONNECTOR_TOOL_NAMES,
	API_CALL_TOOL,
	API_SEARCH_TOOL,
	PROPOSE_API_CONNECTION_TOOL,
	buildApiProposal,
	proposeApiConnection,
	type ProposeApiContext,
} from "./api-connector/tools.js";
export {
	createApiConnectorRuntime,
	defaultApiConnectorStore,
	loadApiConnectorRuntime,
	type ApiConnectorDeps,
	type ApiConnectorRuntime,
	type ApiConnectorStore,
} from "./api-connector/runtime.js";
export {
	ApiOAuthError,
	buildAuthorizeUrl,
	detectPkceSupport,
	exchangeAuthorizationCode,
	getValidAccessToken,
	newPkce,
	refreshAccessToken,
	revokeTokens,
} from "./api-connector/oauth.js";
export { apiSecretValues, openApiSecrets, sealApiSecrets, type ApiConnectorSecrets, type ApiOAuthTokens } from "./api-connector/secrets.js";
export { RateLimiter, ReadCache, resetApiRateLimiters, retryAfterMs } from "./api-connector/rate-limit.js";
export { safeHttpRequest, SafeHttpError } from "./api-connector/safe-http.js";
export { probeMcpServer } from "./mcp/connect.js";
export { SITE_ICON_MAX_BYTES, parseIconHostname, resolveSiteIcon, type SiteIcon } from "./mcp/site-icon.js";
export { humanizeOAuthError, normalizingFetch } from "./mcp/oauth-fetch.js";
export {
	MCP_OAUTH_CALLBACK_PATH,
	MCP_OAUTH_STATE_TTL_MS,
	McpOAuthProvider,
	defaultMcpAuthProviderFactory,
	finishMcpOAuth,
	getFreshAccessToken,
	hashMcpOAuthState,
	mcpOAuthClientFor,
	mcpOAuthLogoUrl,
	mcpOAuthRedirectUrl,
	newMcpOAuthState,
	persistTo,
	resolveMcpOAuthClient,
	startMcpOAuth,
	type McpOAuthClient,
	type McpOAuthPersist,
	type McpOAuthReadiness,
	type McpOAuthStart,
} from "./mcp/oauth-provider.js";
export { accountLabelFromTokens, isAutoAccountLabel } from "./mcp/account-identity.js";
export {
	SecretBoxError,
	getGithubWebhookSecret,
	isSecretBoxConfigured,
	openSecrets,
	readConnectorKey,
	sealSecrets,
	secretValues,
	type McpConnectorSecrets,
	type McpOAuthSecrets,
} from "./mcp/secret-box.js";
export {
	buildMcpClientConfig,
	executeConfirmedMcpCall,
	loadMcpRuntime,
	markMcpConnectionAuthFailed,
	type McpAuthProviderFactory,
	type McpRuntime,
	type McpRuntimeOptions,
} from "./mcp/runtime.js";
export { describePullCiError, fetchPullSnapshot, mapCheckRuns, tailJobLog, type PullSnapshot } from "./github/pull-ci.js";
export {
	getGithubConnectionToken,
	markGithubConnectionAuthFailed,
	type GithubConnectionToken,
	type GithubConnectionTokenResult,
} from "./mcp/github-token.js";
export {
	closeGithubHookSafely,
	createRepoHook,
	deleteRepoHook,
	getPull,
	listBranches,
	listOpenPulls,
	listRepoHooks,
	listUserRepos,
	updateRepoHook,
	type GithubApiError,
	type GithubApiResult,
	type GithubBranch,
	type GithubClientOptions,
	type GithubPull,
	type GithubRepo,
	type GithubRepoHook,
	type GithubRepoHookFull,
} from "./github/client.js";
export {
	COMPOSIO_GITHUB_READ_ACTIONS,
	GITHUB_NOT_CONNECTED_ERROR,
	createComposioGithubReadOps,
	createAppGithubReadOps,
	createNativeGithubReadOps,
	githubReauthMessage,
	resolveGithubReadOps,
	type GithubReadOps,
	type ResolveGithubReadOpsDeps,
} from "./github/read-ops.js";
export { createGithubAppJwt } from "./github/app/jwt.js";
export {
	invalidateGithubAppCredentials,
	loadGithubAppCredentials,
	normalizePrivateKey,
	saveConvertedGithubApp,
	type ConvertedGithubApp,
	type GithubAppCredentials,
} from "./github/app/credentials.js";
export {
	convertManifestCode,
	createInstallationAccessToken,
	exchangeUserOAuthCode,
	fetchInstallationInfo,
	fetchAppPermissions,
	listInstallationRepositories,
	listUserInstallationIds,
	type AppInstallationInfo,
} from "./github/app/api.js";
export {
	GITHUB_APP_STATE_TTL_MS,
	signGithubAppState,
	verifyGithubAppState,
	type GithubAppStatePurpose,
} from "./github/app/state.js";
export {
	GITHUB_APP_EVENTS,
	GITHUB_APP_PERMISSIONS,
	GITHUB_APP_WRITE_PERMISSIONS,
	missingGithubWritePermissions,
	buildGithubAppManifest,
	githubAppUrls,
	githubManifestTarget,
	renderManifestForm,
	sanitizeGithubAppName,
	type GithubAppManifest,
} from "./github/app/manifest.js";
export {
	INSTALLATION_TOKEN_REFRESH_MARGIN_MS,
	clearInstallationTokenCache,
	forgetInstallationTokens,
	getGithubToken,
	getInstallationToken,
	type GithubTokenResult,
} from "./github/app/token.js";
export {
	COMPARE_OUTPUT_MAX_CHARS,
	fetchCompare,
	formatCompareForModel,
	type CompareData,
	type CompareResult,
} from "./github/app/compare.js";
export { enrichGithubEvent, enrichPullRequestEvent, enrichPushEvent } from "./github/app/enrich.js";
export {
	ensureGithubRepoHook,
	DEFAULT_ENSURE_GITHUB_REPO_HOOK_DEPS,
	type EnsureGithubRepoHookDeps,
	type EnsureGithubRepoHookInput,
	type EnsureGithubRepoHookResult,
} from "./github/hook-sync.js";
export {
	NATIVE_FETCH_TIMEOUT_MS,
	assertPublicUrl,
	htmlToText,
	isPrivateAddress,
	nativeWebExtract,
	nativeWebSearch,
	parseDuckDuckGoHtml,
} from "./web-native.js";
export { processImageForStorage, makeModelCopy } from "./images/process.js";
export { fetchImageFromUrl } from "./images/fetch-image.js";
export { executeGenerateImage, parseGenerateImageArgs, GENERATE_IMAGE_TOOL } from "./tools/generate-image.js";
export {
	buildFilePreview,
	renderFile,
	printPdfWithChromium,
	type FilePreview,
	type RenderedFile,
} from "./files/index.js";
export { CREATE_FILE_TOOL, executeCreateFile } from "./tools/create-file.js";
export {
	decisionStepTelemetry,
	modelStepTelemetry,
	navigateTimingTelemetry,
	toolStepTelemetry,
} from "./telemetry/step-telemetry.js";
export {
	createJevTelemetryCollector,
	type JevTelemetryCollector,
} from "./telemetry/jev-telemetry.js";

export { createChatgptAuthService, chatgptAuthService, type ChatgptAuthService, type SiwcDependencies } from "./providers/siwc-service.js";
export { accountChatgptGate, envChatgptGate, type ChatgptGate, type ChatgptGateResolver } from "./providers/chatgpt-gate.js";
export { SiwcAuthError } from "./providers/siwc-protocol.js";
export type { SiwcStatus, SiwcStore, SiwcSecrets } from "./providers/siwc-store.js";
export type { SiwcAccessOptions } from "./providers/siwc-refresh.js";
export { buildConversationArtifactsNote, insertBeforeLastUser, type ConversationArtifactsSummary } from "./conversation-artifacts-note.js";
export {
	COMPOSIO_API_BASE,
	ComposioApiError,
	ComposioInvalidResponseError,
	composioInvalidResponseMessage,
	composioMcpUrl,
	composioServerIdFromUrl,
	composioUserId,
	createComposioClient,
	formatComposioError,
	isComposioNoAuthError,
	type ComposioCategory,
	type ComposioClient,
	type ComposioConnectedAccount,
	type ComposioStep,
	type ComposioToolkit,
	type ComposioToolkitPage,
	type ComposioToolkitSort,
} from "./mcp/composio/client.js";
export { withoutNativeDuplicates } from "./mcp/composio/records.js";
export {
	builtinGroupPointers,
	builtinSkillIndexText,
	builtinSkills,
	findBuiltinSkill,
	loadBuiltinSkills,
	visibleBuiltinSkills,
	parseBuiltinSkill,
	type BuiltinSkill,
} from "./skills/builtin.js";
export { createApiKeyService, apiKeyService, normalizeApiKey, ApiKeyServiceError, type ApiKeyService, type ApiKeyStore, type ApiKeySecrets } from "./providers/api-key-service.js";
export {
	buildAttachmentHistoryNote,
	buildAttachmentTurnContext,
	createExtractCache,
	type AttachmentRef,
	type ExtractCache,
	type ExtractStore,
} from "./attachments/context.js";
export type { AttachmentRuntime } from "./attachments/runtime.js";
export type { ExtractedAttachment, ExtractFailure, Extractor } from "./attachments/extract.js";
export { EXTRACT_CACHE_VERSION } from "./attachments/extract.js";
export { ExtractPool, previewInThread, sharedExtractor, shutdownSharedExtractor, type ExtractPoolOptions } from "./attachments/extract-pool.js";
export { executeAttachmentTool, ATTACHMENT_TOOL_NAMES } from "./tools/attachment-tools.js";
export { VaultService, VaultError, getVaultService, routineSlug, registerHookSecretSealer, type VaultMeta, type VaultPayload, type VaultExtraField, type VaultStore, type CreateVaultItemInput } from "./secrets/vault-service.js";
export { createRedactor, type Redactor, type SecretEntry } from "./secrets/redact.js";
export { createSecretSession, injectSecretRefs, secretToolPolicy, SecretRefError, type SecretSession } from "./secrets/session.js";
export { maskKnownSecrets, maskKnownSecretsInMessages } from "./secrets/mask.js";
export { parseTotpInput, totpAt, base32Decode } from "./secrets/totp.js";
export { rewrapDataKey, unwrapDataKey } from "./secrets/envelope.js";
export { executeRoutineWebhookInfo, executeSecretList, executeSecretRequest, executeLoginFill, VAULT_TOOL_NAMES } from "./tools/vault-tools.js";
export { memoryVaultStore } from "./secrets/memory-store.js";
export {
	GITHUB_APP_INSTALL_PATH,
	gateGithubWrite,
	githubInstallationManageUrl,
	githubSignatureFor,
	isGithubWriteConnector,
	type GithubIdentityBlock,
} from "./github/write/gate.js";
export { planGithubWrite, withGithubSignature } from "./github/write/ops.js";
export { createOpenMailProvider, OPENMAIL_BASE_URL } from "./email/openmail.js";
export { EmailProviderError } from "./email/provider.js";
export type { EmailProvider, EmailCredentials, ParsedInboundEmail, ProviderInbox, ProviderMessage, WebhookVerification } from "./email/provider.js";
export { EmailServiceError, createEmailService, emailService, EMAIL_KEY_CONNECTION } from "./email/service.js";
export type { EmailService, EmailServiceDeps, EmailStore, PreparedSend } from "./email/service.js";
export { EMAIL_TOOLS, EMAIL_TOOL_NAMES, emailToolsFor, decideEmailSend, executeEmailTool } from "./email/tools.js";
export type { EmailRunContext, EmailToolDeps } from "./email/tools.js";
export { loadEmailRunContext } from "./email/run-context.js";
export type { ModelTiersRuntime } from "./model-tiers.js";
export { classifyDifficulty } from "./context/difficulty.js";

export { createMaintenanceLlm, resolveMaintenanceCandidates, createKeyProviderStreams, keyProviderStreamFor, type MaintenanceLlm, type MaintenanceLlmDeps, type MaintenanceBootConfig } from "./maintenance-llm.js";
export { createReviewerClient, REVIEWER_JUDGE_MODEL_DEFAULT, type ReviewerClient, type ReviewerLlmDeps } from "./reviewer-llm.js";
