// Giro do avatar no próprio eixo vertical (yaw de 360°), como o `spin` do motor do web
// (`Character.spin()`: `yaw += 180 · (1 − cos(π·t/spinS))`). Aqui em laço contínuo, para a tela "Conectando".
// Funções puras: o relógio entra por parâmetro.

/** Uma volta completa, em segundos. */
export const SPIN_PERIOD_S = 1.6;
/** Passos de yaw por volta (7,5° cada): limita o cache de quadros e dá ~30 quadros por segundo na volta de 1,6 s. */
export const SPIN_STEPS = 48;

export type SpinEase = "linear" | "motor";

/**
 * Yaw em graus, em [0, 360), para `elapsedS` segundos de giro. `linear` (padrão) é velocidade constante, que não
 * dá a impressão de parada a cada volta; `motor` é a curva do motor do web (devagar de frente, rápido de lado).
 */
export function spinYaw(elapsedS: number, periodS: number = SPIN_PERIOD_S, ease: SpinEase = "linear"): number {
	if (!Number.isFinite(elapsedS) || !Number.isFinite(periodS) || periodS <= 0) return 0;
	const raw = (elapsedS % periodS) / periodS;
	const phase = raw < 0 ? raw + 1 : raw;
	const turn = ease === "motor" ? (1 - Math.cos(Math.PI * phase)) / 2 : phase;
	// O arredondamento perto de 1 não pode devolver 360 (é o mesmo que 0).
	const yaw = turn * 360;
	return yaw >= 360 ? 0 : yaw;
}

/** Passo (0 a `SPIN_STEPS - 1`) do giro: o yaw arredondado para baixo na grade de 360 / `SPIN_STEPS` graus. */
export function spinStep(elapsedS: number, periodS: number = SPIN_PERIOD_S, ease: SpinEase = "linear"): number {
	return Math.min(SPIN_STEPS - 1, Math.floor(spinYaw(elapsedS, periodS, ease) / (360 / SPIN_STEPS)));
}

/** Yaw em graus de um passo. */
export function stepYaw(step: number): number {
	return (step % SPIN_STEPS) * (360 / SPIN_STEPS);
}
