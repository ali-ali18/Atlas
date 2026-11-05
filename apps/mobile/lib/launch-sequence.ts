// Abertura animada do app: a linha do tempo e a pose do personagem em cada instante. Funções puras (o relógio entra
// por parâmetro); quem desenha é `components/launch/launch-overlay.tsx`.
//
// A animação é o clipe `Rotation_A` do motor ("celebrate", rosto `happy`), mais calmo que no web: uma volta só (360°)
// com easing macio em vez das duas voltas do clipe, e sem scale na saída (sai só com fade). Antes dela o personagem
// está igual ao splash nativo (mesma posição, tamanho e pose da lista); depois dela, se o app ainda carrega, fica num
// repouso calmo do motor (`Idle_A`) até a hora de sair.
import type { Frame } from "@workspace/shared/avatar/model/character";
import { BODY_RADIUS_PX } from "@workspace/shared/avatar/geometry/shapes";
import { DEFAULT_ZOOM, getClip, lerpPose, poseAt, restPose, type Pose } from "@workspace/shared/avatar/model/clips";
import { LIST_POSE } from "./avatar-pose";
import { redirectFor, type AccessPhase } from "./auth-flow";

export const LAUNCH_TIMING = {
	/** Parado, igual ao splash nativo. */
	holdS: 0.15,
	/** Fim da virada de frente (a pose da lista vai ao clipe; o tamanho não muda). */
	growEndS: 0.7,
	/** O rosto vira feliz um pouco antes do giro. */
	happyAtS: 0.5,
	spinStartS: 0.55,
	spinEndS: 2.25,
	/** Volta ao repouso, uma pausa curtinha e então a saída. */
	introEndS: 2.55,
	fadeS: 0.3,
	/** Teto: se o app não ficou pronto, sai assim mesmo. */
	safetyS: 8,
	/** Com "reduzir movimento": tempo mínimo na tela antes do fade (sem isso o splash piscaria). */
	reducedHoldS: 0.4,
	/** A imagem do splash nativo some em cima do desenho do motor neste tempo (o sombreado dela é só da imagem). */
	handoffS: 0.2,
} as const;

/** Lado da caixa do splash nativo (`imageWidth` em app.json), o mesmo do começo ao fim: a animação não cresce. O corpo ocupa ~70,5% da caixa. */
export const LAUNCH_SIZE = 92;

/** Uma volta do clipe `Rotation_A`: tempo do clipe em que o yaw (linear no clipe) completa 360° desde o início. */
const ROTATION_CLIP = "Rotation_A";
const CLIP_YAW_START = -34.69807;
const CLIP_YAW_AT_3S = 393.29316;
const CLIP_YAW_TIME_S = 3.04206;
const TURN_CLIP_S = (CLIP_YAW_TIME_S * 360) / (CLIP_YAW_AT_3S - CLIP_YAW_START);
/** Último trecho do giro (fração) em que a pose volta ao repouso de frente. */
const SETTLE_FRACTION = 0.22;

/** Repouso calmo enquanto o app carrega. */
export const LAUNCH_IDLE_CLIP = "Idle_A";

const LIST_ENGINE_POSE: Pose = { rot: [LIST_POSE.pitch, LIST_POSE.yaw, LIST_POSE.roll], pos: [0, 0], squash: [1, 1], zoom: DEFAULT_ZOOM };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const smootherstep = (x: number) => x * x * x * (x * (6 * x - 15) + 10);

export type LaunchPhase = "intro" | "idle" | "fade" | "done";

export type LaunchState = {
	phase: LaunchPhase;
	/** Segundos desde o início da abertura, limitado ao fim da animação (vale na fase `intro`). */
	introT: number;
	/** Segundos no repouso (fase `idle`). */
	idleT: number;
	/** Progresso do fade de saída, 0 a 1. */
	fade: number;
};

/**
 * Instante (s desde o início) em que o fade começa. Passou da animação e o app está pronto: sai. Não está pronto: espera,
 * até o teto. Ficou pronto antes da animação acabar: ela termina (roda inteira pelo menos uma vez). Com "reduzir
 * movimento" não há animação: só o tempo mínimo.
 */
export function fadeStartS(readyAtS: number | null, reducedMotion: boolean): number {
	const floor = reducedMotion ? LAUNCH_TIMING.reducedHoldS : LAUNCH_TIMING.introEndS;
	const wanted = readyAtS === null ? Number.POSITIVE_INFINITY : Math.max(floor, readyAtS);
	return Math.min(LAUNCH_TIMING.safetyS, wanted);
}

/** Fase da abertura em `elapsedS`; `readyAtS` é quando o app ficou pronto (nulo se ainda não ficou). */
export function launchState(input: { elapsedS: number; readyAtS: number | null; reducedMotion: boolean }): LaunchState {
	const { elapsedS, readyAtS, reducedMotion } = input;
	const t = Number.isFinite(elapsedS) ? Math.max(0, elapsedS) : 0;
	const fadeAt = fadeStartS(readyAtS, reducedMotion);
	const introEnd = LAUNCH_TIMING.introEndS;
	if (t >= fadeAt + LAUNCH_TIMING.fadeS) return { phase: "done", introT: Math.min(t, introEnd), idleT: Math.max(0, t - introEnd), fade: 1 };
	if (t >= fadeAt) return { phase: "fade", introT: Math.min(t, introEnd), idleT: Math.max(0, t - introEnd), fade: (t - fadeAt) / LAUNCH_TIMING.fadeS };
	// Com "reduzir movimento" não há fase `intro`: o personagem fica parado (quem desenha ignora o repouso) até o fade.
	if (reducedMotion || t >= introEnd) return { phase: "idle", introT: Math.min(t, introEnd), idleT: Math.max(0, t - introEnd), fade: 0 };
	return { phase: "intro", introT: t, idleT: 0, fade: 0 };
}

/** Opacidade do overlay inteiro (fundo e personagem): 1 até o fade, depois cai suave a 0. Nada de scale. */
export function launchOpacity(state: LaunchState): number {
	return 1 - easeInOutCubic(clamp01(state.fade));
}

/** Pose do giro (u de 0 a 1): o clipe `Rotation_A` reamostrado numa volta só, com easing macio, voltando ao repouso no fim. */
function spinPose(u: number): Pose {
	const pose = poseAt(getClip(ROTATION_CLIP), TURN_CLIP_S * smootherstep(clamp01(u)));
	const settleFrom = 1 - SETTLE_FRACTION;
	return u > settleFrom ? lerpPose(pose, restPose(), easeInOutCubic((u - settleFrom) / SETTLE_FRACTION)) : pose;
}

export type IntroFrame = {
	pose: Pose;
	/** Lado da caixa do personagem, em pt. */
	size: number;
	/** Rosto feliz (o motor faz a transição dos olhos). */
	happy: boolean;
	/** Opacidade da imagem do splash nativo por cima do desenho (1 = só a imagem, igual ao splash). */
	splashImage: number;
};

/** Personagem em `t` segundos da animação de entrada (`t` limitado a [0, introEndS]). */
export function introFrame(t: number): IntroFrame {
	const T = LAUNCH_TIMING;
	const time = Math.min(T.introEndS, Math.max(0, t));
	const turn = easeInOutCubic(clamp01((time - T.holdS) / (T.growEndS - T.holdS)));
	const u = clamp01((time - T.spinStartS) / (T.spinEndS - T.spinStartS));
	return {
		pose: lerpPose(LIST_ENGINE_POSE, spinPose(u), turn),
		size: LAUNCH_SIZE,
		happy: time >= T.happyAtS,
		splashImage: 1 - clamp01((time - T.holdS) / T.handoffS),
	};
}

/** Escreve a pose do clipe no quadro do motor (mesma conta do `Character.frame()`: zoom relativo ao padrão, squash, deslocamento em raios). */
export function applyPoseToFrame(frame: Frame, pose: Pose): void {
	const zoom = pose.zoom / DEFAULT_ZOOM;
	const unit = BODY_RADIUS_PX * frame.fit;
	frame.orientation = { pitch: pose.rot[0], yaw: pose.rot[1], roll: pose.rot[2] };
	frame.scale = zoom;
	frame.scaleX = pose.squash[0];
	frame.scaleY = pose.squash[1];
	frame.squashAnchor = 0;
	frame.offsetX = pose.pos[0] * unit * zoom;
	frame.offsetY = -pose.pos[1] * unit * zoom;
}

/**
 * A abertura pode se dar por pronta? O app está de pé quando a rota certa já está na tela: com servidor e sessão, a home
 * (carregada e sincronizada, não mais a `/syncing`); sem sessão, o Login; sem servidor, a Conexão.
 */
export function isAppReady(input: { phase: AccessPhase; pathname: string; synced: boolean }): boolean {
	const { phase, pathname, synced } = input;
	if (phase === "loading") return false;
	if (phase === "signed-in" && (!synced || pathname === "/syncing")) return false;
	return redirectFor(phase, pathname, synced) === null;
}
