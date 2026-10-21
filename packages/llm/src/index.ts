export {
	OpenRouterError,
	completeChat,
	streamChat,
	type CompleteChatParams,
	type CompleteChatResult,
	type StreamChatHandlers,
} from "./openrouter.js";
export {
	completeChatWithTools,
	streamChatWithTools,
	chatRequestBody,
	type ChatTool,
	type LlmMessage,
	type LlmProviderItems,
	type LlmContentPart,
	type LlmToolCall,
	type LlmUsage,
	type CompleteChatWithToolsParams,
	type CompleteChatWithToolsResult,
	type StreamChatWithToolsHandlers,
} from "./chat-tools.js";
export { demoteSystemNotes, remapStableIndex, SYSTEM_NOTE_OPEN, SYSTEM_NOTE_CLOSE } from "./system-notes.js";
export { responsesRequestBody } from "./responses/request.js";
export { fetchGenerationCost, type GenerationCostResult } from "./generation-cost.js";
export {
	embedText,
	DEFAULT_EMBEDDING_MODEL,
	DEFAULT_EMBEDDING_DIMS,
	type EmbedTextParams,
	type EmbedTextResult,
} from "./embeddings.js";
export { askJevViaChat } from "./jev-chat.js";
export { JEV_MCP_QUESTIONS, mcpDecisionFromAnswers, askJev, evaluateMcpWithJev, type JevAnswers, type JevQuestion, JEV_MCP_MODEL, JEV_MCP_TIMEOUT_MS, type JevMcpDecision, type JevMcpState } from "./jev-decisions.js";
export {
	DEFAULT_MODEL_CALL_TIMEOUT_MS,
	modelCallSignal,
} from "./signal.js";
export {
	OPENROUTER_STEP_RETRY_DELAYS_MS,
	isRetryableLlmError,
	readOpenRouterFallbackModels,
	withLlmStepRetry,
	type SleepFn,
} from "./config.js";
export {
	createCallTimer,
	retryReasonCategory,
	type CallTimer,
	type LlmCallTiming,
	type LlmRetryReason,
} from "./timing.js";
export {
	MAX_CACHE_BREAKPOINTS,
	applyCacheBreakpoints,
	stripCacheBreakpoints,
	supportsExplicitPromptCache,
} from "./prompt-cache.js";
export { generateImages, IMAGE_GENERATION_TIMEOUT_MS, type GenerateImagesParams, type GenerateImagesResult } from "./images.js";
export {
	parseNativeComputerMode,
	supportsNativeComputerTool,
	type NativeComputerMode,
} from "./computer-native.js";

export { createModelCatalogCache } from "./model-catalog-cache.js";

export { createProviderStreamChat, type ProviderStreamChat } from "./provider-router.js";
export { createReserveModelStream } from "./reserve-models.js";
export { createChatgptStreamChat, type ChatgptStreamOptions, type ChatgptTokenOptions } from "./responses/stream.js";
export { ChatgptProviderError, isRetryableChatgptError } from "./responses/errors.js";
export { providerModelCapabilities, type ProviderModelCapabilities } from "./responses/capabilities.js";
export { createChatgptModelCatalog } from "./provider-model-catalog.js";


export { createProviderFallbackStream, NoFallbackModelError, type ProviderFallbackNotice } from "./provider-fallback.js";
export {
	transcribeAudio,
	readSttConfig,
	classifySttError,
	TranscriptionError,
	type SttErrorCode,
	DEFAULT_STT_MODEL,
	DEFAULT_OPENROUTER_STT_MODEL,
	DEFAULT_STT_BASE_URL,
	type SttConfig,
	type TranscribeAudioParams,
} from "./transcription.js";

export {
	OPENAI_STT_MODELS,
	applyUserSttModel,
	fetchOpenRouterTranscriptionModels,
	parseTranscriptionModel,
	pricePerMinute,
} from "./transcription-models.js";

export { ProviderApiError, classifyProviderHttpError, providerFailureKind, parseRetryAfterMs, isRetryableProviderError, redactKey, type ProviderErrorCode, type ProviderFailureKind, type KeyProviderName } from "./provider-errors.js";
export { createAnthropicStreamChat, readAnthropicSse, anthropicUsage, ANTHROPIC_API_BASE_URL, ANTHROPIC_VERSION, type AnthropicStreamOptions } from "./anthropic/stream.js";
export { anthropicRequestBody, toAnthropicMessages, toAnthropicTools, type AnthropicRequest } from "./anthropic/convert.js";
export { OPENCODE_GO_BASE_URL, goProtocolFor, goEndpointUrl, protocolFromSlug, protocolFromMetadata, type GoProtocol } from "./opencode/routing.js";
export { createOpencodeGoStreamChat, opencodeGoHeaders, OPENCODE_USER_AGENT, type OpencodeGoStreamOptions } from "./opencode/stream.js";
export { fetchAnthropicModels, fetchOpencodeGoModels, parseOpencodeGoModels, type ApiKeyCatalog } from "./api-key-models.js";
export { createApiKeyModelCatalog, type ApiKeyModelCatalog } from "./api-key-catalog.js";
