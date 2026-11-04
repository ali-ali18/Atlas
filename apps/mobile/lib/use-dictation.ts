// Hook fino do ditado: só liga o controlador (lib/dictation-controller.ts) ao React e ao módulo nativo.
import * as React from "react";
import { deviceLanguage } from "./device-language";
import { speechLocaleFor, type DictationOutcome, type DictationProblem } from "./dictation";
import { createDictationController, type DictationView } from "./dictation-controller";
import { loadSpeechEngine } from "./speech-native";

const IDLE: DictationView = { phase: "idle", spoken: "", level: 0 };

export type DictationState = DictationView & {
	start: () => void;
	/** Para de ouvir: `review` leva o texto ao campo, `send` envia direto. */
	stop: (next?: "review" | "send") => void;
	cancel: () => void;
};

export function useDictation({ onFinish, onProblem }: { onFinish: (result: { outcome: DictationOutcome; spoken: string }) => void; onProblem: (problem: DictationProblem) => void }): DictationState {
	const [view, setView] = React.useState<DictationView>(IDLE);
	const finishRef = React.useRef(onFinish);
	const problemRef = React.useRef(onProblem);
	finishRef.current = onFinish;
	problemRef.current = onProblem;
	const controller = React.useMemo(
		() =>
			createDictationController({
				engine: loadSpeechEngine(),
				timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) },
				language: speechLocaleFor(deviceLanguage()),
				onChange: setView,
				onFinish: (result) => finishRef.current(result),
				onProblem: (problem) => problemRef.current(problem),
			}),
		[],
	);
	// Saiu da tela no meio do ditado: solta o microfone sem inserir nada.
	React.useEffect(() => () => controller.cancel(), [controller]);
	return { ...view, start: () => void controller.start(), stop: (next) => controller.stop(next), cancel: controller.cancel };
}
