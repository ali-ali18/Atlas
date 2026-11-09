// Porta `Settings`: configurar o bot pelo chat (F2.4). O bot vem preso no adaptador (um por run); toda chamada leva o
// `userId` e o adaptador só mexe no que é do dono. O modelo por PAPEL (`AgentModelRole`) é guardado como referência de
// modelo (`parseModelRef`); papel sem entrada usa o padrão da conta/servidor.
import type { CodeMode, MODEL_ROLES } from "@workspace/shared";

/** Papéis do Llm. O `ModelRole` do índice do shared é outro tipo (papéis do subagente): este vem de `MODEL_ROLES`. */
export type AgentModelRole = (typeof MODEL_ROLES)[number];

export type BotProfile = { name: string; snippet: string; description: string };

export type BotSettingsView = BotProfile & {
	/** Idioma fixo (`pt-BR`, `en-US`…) ou `auto`. */
	language: string;
	notify: boolean;
	/** Só os papéis que o dono configurou. */
	roleModels: Partial<Record<AgentModelRole, string>>;
};

export type BotSettingsPatch = {
	language?: string;
	notify?: boolean;
	/** `null` devolve o papel ao padrão. */
	roleModels?: Partial<Record<AgentModelRole, string | null>>;
	profile?: Partial<BotProfile>;
};

/** Modo de código do bot (F8.2, `Bot.policyJson.codeMode`). O adaptador filtra tudo pelo dono do bot. */
export interface CodeModeSetting {
	get(userId: string): Promise<CodeMode>;
	/** Grava o modo e devolve o que ficou valendo. Bot de outro dono = erro (mesmo de inexistente). */
	set(userId: string, mode: CodeMode): Promise<CodeMode>;
	/** O ambiente de código existe neste servidor? Sem ele o modo é guardado, mas as tools de código seguem desligadas. */
	readonly environmentAvailable: boolean;
}

export interface Settings {
	/** Modo de código do bot. Ausente = o adaptador não guarda e a tool `settings_set_code_mode` não é registrada. */
	readonly codeMode?: CodeModeSetting;
	/**
	 * O adaptador guarda modelo por papel? Sem suporte, a capacidade não registra `set_role_model` e `settings_get`
	 * não lista papéis (um "default" fingiria escolha que o dono não pode fazer).
	 */
	readonly supportsRoleModels: boolean;
	get(userId: string): Promise<BotSettingsView>;
	update(userId: string, patch: BotSettingsPatch): Promise<BotSettingsView>;
	/** Modelos que o dono pode escolher (ids de modelo). Sem isto, só a forma da referência é conferida. */
	availableModels?(userId: string): Promise<readonly string[]>;
}
