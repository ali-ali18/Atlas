import { Character, type Frame } from "@workspace/shared/avatar/model/character";
import { projectFrame } from "@workspace/shared/avatar/render/project";
import { groupTransform } from "@workspace/shared/avatar/render/svg";
import * as React from "react";
import { Image, StyleSheet, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { LaunchMascot, type LaunchMascotFrame } from "@/components/launch/launch-mascot";
import { SPLASH_BACKGROUND } from "@/components/splash-screen";
import { applyPoseToFrame, introFrame, LAUNCH_IDLE_CLIP, LAUNCH_SIZE_FROM, LAUNCH_SIZE_TO, launchOpacity, launchState } from "@/lib/launch-sequence";

// Mesma imagem do splash nativo (app.json): na troca do nativo para esta tela o personagem não muda de lugar nem de cara.
const SPLASH_IMAGE = require("../../assets/splash-icon.png");

/** Se a imagem não carregar nem avisar, a abertura segue assim mesmo (o splash nativo não pode ficar preso). */
const IMAGE_FALLBACK_MS = 800;
/** Passo máximo entre quadros: depois de uma travada o motor não pula a animação. */
const MAX_STEP_S = 0.05;

type OverlayFrame = LaunchMascotFrame & { splashImage: number; opacity: number };
type Runtime = { happy: boolean; idling: boolean };

/** O quadro no instante dado. Muta `character` (avança o tempo do motor e escolhe rosto e clipe) e `runtime`. */
function renderAt(character: Character, runtime: Runtime, input: { elapsedS: number; readyAtS: number | null; reducedMotion: boolean; stepS: number }): { frame: OverlayFrame; done: boolean } {
	const state = launchState(input);
	character.advance(input.stepS);
	const finish = (engineFrame: Frame, size: number, splashImage: number) => {
		const projected = projectFrame(engineFrame);
		return { frame: { body: projected.body, eyes: projected.eyes, transform: groupTransform(engineFrame), size, splashImage, opacity: launchOpacity(state) }, done: state.phase === "done" };
	};
	if (input.reducedMotion) {
		// Sem movimento: parado como o splash nativo até o fade.
		const engineFrame = character.frame();
		applyPoseToFrame(engineFrame, introFrame(0).pose);
		return finish(engineFrame, LAUNCH_SIZE_FROM, 1);
	}
	if (state.phase === "intro") {
		const intro = introFrame(state.introT);
		if (intro.happy && !runtime.happy) {
			character.setExpression("happy", { duration: 0.25 });
			runtime.happy = true;
		}
		const engineFrame = character.frame();
		applyPoseToFrame(engineFrame, intro.pose);
		return finish(engineFrame, intro.size, intro.splashImage);
	}
	// Depois da entrada: repouso calmo do motor (com a ponte do próprio clipe) até o app ficar pronto.
	if (!runtime.happy) {
		character.setExpression("happy", { duration: 0.25 });
		runtime.happy = true;
	}
	if (!runtime.idling) {
		character.playClip(LAUNCH_IDLE_CLIP);
		runtime.idling = true;
	}
	return finish(character.frame(), LAUNCH_SIZE_TO, 0);
}

export type LaunchOverlayProps = {
	/** O app já mostra a tela certa (sessão conferida, home carregada, ou Login/Conexão). */
	ready: boolean;
	/** Chamado uma vez, quando o overlay já está desenhado: aí o splash nativo pode sair sem troca visível. */
	onShown: () => void;
};

/**
 * Abertura animada, em tela cheia por cima do app (montada no layout raiz). O splash nativo fica até esta tela estar
 * desenhada, com o personagem no mesmo lugar e tamanho dele; então roda a animação (`lib/launch-sequence.ts`: cresce,
 * uma volta feliz, repouso), espera o app ficar pronto num repouso calmo (teto de segurança de 8 s) e sai só com fade.
 * Com "reduzir movimento" fica parado e só faz o fade. Roda uma vez por abertura do app e depois se desmonta.
 */
export function LaunchOverlay({ ready, onShown }: LaunchOverlayProps) {
	const reducedMotion = useReducedMotion();
	const reducedRef = React.useRef(reducedMotion);
	reducedRef.current = reducedMotion;
	const readyRef = React.useRef(ready);
	readyRef.current = ready;
	const onShownRef = React.useRef(onShown);
	onShownRef.current = onShown;

	const [imageReady, setImageReady] = React.useState(false);
	const [gone, setGone] = React.useState(false);
	const character = React.useMemo(() => {
		const instance = new Character({ body: "squircle", seed: 0, breathe: false });
		instance.setExpression("neutral", { duration: 0 });
		return instance;
	}, []);
	const runtime = React.useRef<Runtime>({ happy: false, idling: false });
	// Primeiro quadro (instante 0): igual ao splash nativo. Depois a animação troca por um por quadro.
	const [frame, setFrame] = React.useState<OverlayFrame>(() => renderAt(character, { happy: false, idling: false }, { elapsedS: 0, readyAtS: null, reducedMotion: false, stepS: 0 }).frame);

	React.useEffect(() => {
		const timer = setTimeout(() => setImageReady(true), IMAGE_FALLBACK_MS);
		return () => clearTimeout(timer);
	}, []);

	React.useEffect(() => {
		if (!imageReady) return;
		let frameId = 0;
		let cancelled = false;
		let startedAt = 0;
		let last = 0;
		let readyAtS: number | null = null;
		const tick = () => {
			if (cancelled) return;
			const now = Date.now();
			const elapsedS = (now - startedAt) / 1000;
			if (readyAtS === null && readyRef.current) readyAtS = elapsedS;
			const result = renderAt(character, runtime.current, { elapsedS, readyAtS, reducedMotion: reducedRef.current, stepS: Math.min(MAX_STEP_S, (now - last) / 1000) });
			last = now;
			setFrame(result.frame);
			if (result.done) setGone(true);
			else frameId = requestAnimationFrame(tick);
		};
		// Dois quadros para o primeiro desenho chegar à tela; só então o splash nativo sai e o relógio da animação começa.
		frameId = requestAnimationFrame(() => {
			frameId = requestAnimationFrame(() => {
				if (cancelled) return;
				onShownRef.current();
				startedAt = Date.now();
				last = startedAt;
				tick();
			});
		});
		return () => {
			cancelled = true;
			cancelAnimationFrame(frameId);
		};
	}, [imageReady, character]);

	if (gone) return null;
	return (
		<View
			accessibilityLabel="Carregando"
			accessibilityRole="progressbar"
			pointerEvents="auto"
			style={[StyleSheet.absoluteFill, { backgroundColor: SPLASH_BACKGROUND, opacity: frame.opacity, alignItems: "center", justifyContent: "center", zIndex: 1000, elevation: 1000 }]}
		>
			<LaunchMascot body={frame.body} eyes={frame.eyes} transform={frame.transform} size={frame.size} eyeColor={SPLASH_BACKGROUND} />
			{frame.splashImage > 0 ? (
				<Image source={SPLASH_IMAGE} onLoad={() => setImageReady(true)} onError={() => setImageReady(true)} resizeMode="contain" style={{ position: "absolute", width: frame.size, height: frame.size, opacity: frame.splashImage }} />
			) : null}
		</View>
	);
}
