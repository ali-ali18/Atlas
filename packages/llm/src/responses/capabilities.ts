import type { ModelProvider } from "@workspace/shared";
export type ProviderModelCapabilities = {
	supportsVision: boolean;
	supportsTools: boolean;
	supportsOutputCap: boolean;
};

/** Visão não é presumida para um modelo ainda ausente do catálogo. */
export function providerModelCapabilities(provider: ModelProvider, catalog?: Partial<Pick<ProviderModelCapabilities, "supportsVision" | "supportsTools">>): ProviderModelCapabilities {
	return {
		supportsVision: catalog?.supportsVision ?? false,
		supportsTools: catalog?.supportsTools ?? false,
		supportsOutputCap: provider === "openrouter",
	};
}
