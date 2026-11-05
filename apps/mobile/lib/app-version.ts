import { versionLabel } from "./settings-format";

/** Versão do app (`expo.version`) e, quando há atualização OTA instalada, o início do id dela. Fora do app, vazio. */
export function appVersionLabel(): string {
	let version: string | null = null;
	let updateId: string | null = null;
	try {
		version = (require("expo-constants") as typeof import("expo-constants")).default.expoConfig?.version ?? null;
	} catch {
		// sem o módulo (teste): segue sem versão
	}
	try {
		updateId = (require("expo-updates") as typeof import("expo-updates")).updateId ?? null;
	} catch {
		// build sem atualizações: sem id
	}
	return versionLabel(version, updateId);
}
