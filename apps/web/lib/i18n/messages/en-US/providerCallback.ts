import type { providerCallback as ptBR } from "../pt-BR/providerCallback";
import type { NamespaceMessages } from "../../translator";

export const providerCallback: NamespaceMessages<typeof ptBR> = {
	"providerCallback.genericError": "Sign-in wasn't completed. Please try again.",
	"providerCallback.working": "Connecting to ChatGPT…",
	"providerCallback.success": "ChatGPT connected",
	"providerCallback.error": "Couldn't connect",
	"providerCallback.canClose": "You can close this window now.",
	"providerCallback.retry": "Try again",
	"providerCallback.close": "Close",
	"providerCallback.backToApp": "Back to the app",
	"providerCallback.appTile": "App",
};
