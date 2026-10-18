import type { AccountConfigPatch, AccountConfigV1 } from "./account-config.js";
import type { EffectiveAccountConfig } from "./effective-config.js";

/** Configurações por usuário do Atlas (usuário único por enquanto). */
export type UserSettings = {
	sandboxAutoStart: boolean;
};

export type UpdateUserSettingsInput = {
	sandboxAutoStart?: boolean;
};

/** Booleanos não secretos que a UI usa para habilitar controles. */
export type SettingsCapabilities = {
	openrouterKey: boolean;
	isOwner: boolean;
};

/** Resposta de `GET`/`PATCH /v1/settings`. */
export type AccountSettingsResponse = {
	settings: UserSettings;
	/** O que o usuário gravou (vazio = tudo herdado). */
	config: AccountConfigV1;
	/** Valor efetivo + origem (usuário, env ou padrão) de cada configuração. */
	effective: EffectiveAccountConfig;
	capabilities: SettingsCapabilities;
};

export type UpdateAccountSettingsInput = UpdateUserSettingsInput & {
	config?: AccountConfigPatch;
};
