// Adaptador do módulo nativo `expo-speech-recognition`. O `require` é protegido: no Expo Go (e na web, e nos testes) o módulo
// nativo não existe e `requireNativeModule` lança. Aí devolvemos `null` e o ditado só avisa; o app não quebra.
import { Platform } from "react-native";
import type { SpeechEngine } from "./dictation-controller";

export function loadSpeechEngine(): SpeechEngine | null {
	if (Platform.OS === "web") return null;
	try {
		const { ExpoSpeechRecognitionModule: native } = require("expo-speech-recognition") as typeof import("expo-speech-recognition");
		return {
			available: () => native.isRecognitionAvailable(),
			supportsOnDevice: () => native.supportsOnDeviceRecognition(),
			requestPermissions: async () => ({ granted: (await native.requestPermissionsAsync()).granted }),
			start: ({ lang, onDevice }) =>
				native.start({
					lang,
					interimResults: true,
					continuous: true,
					// Só pede reconhecimento no aparelho quando ele suporta; senão usa o serviço do sistema.
					requiresOnDeviceRecognition: onDevice,
					volumeChangeEventOptions: { enabled: true, intervalMillis: 120 },
				}),
			stop: () => native.stop(),
			abort: () => native.abort(),
			onResult: (listener) => {
				const sub = native.addListener("result", (event) => listener({ transcript: event.results[0]?.transcript ?? "", isFinal: event.isFinal }));
				return () => sub.remove();
			},
			onSpeechStart: (listener) => {
				const sub = native.addListener("speechstart", () => listener());
				return () => sub.remove();
			},
			onVolume: (listener) => {
				const sub = native.addListener("volumechange", (event) => listener(event.value));
				return () => sub.remove();
			},
			onEnd: (listener) => {
				const sub = native.addListener("end", () => listener());
				return () => sub.remove();
			},
			onError: (listener) => {
				const sub = native.addListener("error", (event) => listener(event.error));
				return () => sub.remove();
			},
		};
	} catch {
		return null;
	}
}
