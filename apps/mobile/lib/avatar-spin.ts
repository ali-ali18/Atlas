// Giro do avatar no próprio eixo vertical (yaw de 360°), como o `spin` do motor do web
// (`Character.spin()`: `yaw += 180 · (1 − cos(π·t/spinS))`). Aqui em laço contínuo, para a tela "Conectando".
// Funções puras: o relógio entra por parâmetro.

/** Uma volta completa, em segundos. */
export const SPIN_PERIOD_S = 1.6;
/** Passos de yaw por volta (7,5° cada): limita o cache de quadros e dá ~30 quadros por segundo na volta de 1,6 s. */
export const SPIN_STEPS = 48;

export type SpinEase = "linear" | "motor";

/** Pose do motor em graus (mesmos eixos de `avatar-pose.ts`: yaw + = direita, pitch − = para cima, roll + = olhos em "\\"). */
export type SpinPose = { yaw: number; pitch: number; roll: number };

/** Yaw de base: o corpo já vem virado um pouco para o lado (a esfera "meio de lado" do Grok). */
export const SPIN_BASE_YAW = 26;
/** Pitch de base: negativo olha para cima (convenção do motor, a mesma da pose das listas). */
export const SPIN_BASE_PITCH = -18;
/** Roll de base: inclinação leve dos olhos. */
export const SPIN_BASE_ROLL = 12;
/** Pose de repouso do giro (e a que fica parada com "reduzir movimento"): de lado, olhando para cima. */
export const SPIN_BASE_POSE: SpinPose = { yaw: SPIN_BASE_YAW, pitch: SPIN_BASE_PITCH, roll: SPIN_BASE_ROLL };

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

/** Pose no passo `step` do giro: a base mais o yaw do passo (o giro é em torno do eixo já inclinado; pitch e roll não mudam). */
export function spinPoseAtStep(step: number, base: SpinPose = SPIN_BASE_POSE): SpinPose {
	return { yaw: (base.yaw + stepYaw(step)) % 360, pitch: base.pitch, roll: base.roll };
}

/** Pose para `elapsedS` segundos de giro (base + yaw por tempo), na grade de passos que o avatar usa. */
export function spinPose(elapsedS: number, periodS: number = SPIN_PERIOD_S, ease: SpinEase = "linear", base: SpinPose = SPIN_BASE_POSE): SpinPose {
	return spinPoseAtStep(spinStep(elapsedS, periodS, ease), base);
}
