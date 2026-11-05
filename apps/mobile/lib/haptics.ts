// Retorno tátil que respeita a preferência do dono (Configurações > App > Retorno tátil). Toda vibração do app passa
// por `tap()`: quem desligou não sente nada em lugar nenhum.

/** Fábrica separada para testar sem o módulo nativo. `play` é o toque de verdade. */
export function createHaptics(play: () => unknown, initial = true) {
	let enabled = initial;
	return {
		tap(): void {
			if (!enabled) return;
			try {
				void Promise.resolve(play()).catch(() => undefined);
			} catch {
				// aparelho sem vibração: segue sem
			}
		},
		setEnabled(value: boolean): void {
			enabled = value === true;
		},
		isEnabled: (): boolean => enabled,
	};
}

const shared = createHaptics(() => {
	// require tardio: o módulo nativo não carrega fora do app (vitest)
	const Haptics = require("expo-haptics") as typeof import("expo-haptics");
	return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
});

/** Toque leve (interruptor, enviar, segurar mensagem). */
export const tap = shared.tap;
export const setHapticsEnabled = shared.setEnabled;
