// `Llm` do sono (F5.3): o papel `sleep` do v4 sobre o roteador de provedores do worker. A cadeia do papel começa no modelo
// barato (`ATLAS_V4_CHEAP_MODEL`, Haiku por padrão) e só cai no modelo do bot se o barato não estiver disponível; o dono
// manda por papel quando `roleModels` existir. Chave e fallback por provedor são os mesmos dos runs.
import type { Llm } from "@workspace/agent";
import { getBotModelForUser } from "@workspace/db";
import type { WorkerConfig } from "./config.js";
import { cheapModelFromEnv, createV4Llm } from "./engine-v4.js";
import { createRunProviderServices } from "./provider-services.js";
import { resolveDefaultModelForJob } from "./run-config.js";

export async function createSleepLlm(input: { userId: string; botId: string; policyJson: unknown; config: WorkerConfig; log?: (line: string) => void }): Promise<Llm> {
	const model = (await getBotModelForUser(input.botId, input.userId)) ?? (await resolveDefaultModelForJob({ userId: input.userId, serverDefault: input.config.openRouterModel }));
	const providers = createRunProviderServices({
		userId: input.userId,
		policy: input.policyJson,
		openRouterKey: Boolean(input.config.openRouterApiKey),
		onFallback: (notice) => input.log?.(`[sleep] user=${input.userId} bot=${input.botId} provedor alternativo: ${notice.type}`),
	});
	return createV4Llm({ model, streamChat: providers.streamChat, openRouterKey: input.config.openRouterApiKey ?? "", cheapModel: cheapModelFromEnv() });
}
