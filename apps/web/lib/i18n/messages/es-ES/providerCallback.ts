import type { providerCallback as ptBR } from "../pt-BR/providerCallback";
import type { NamespaceMessages } from "../../translator";

export const providerCallback: NamespaceMessages<typeof ptBR> = {
	"providerCallback.genericError": "No se completó el inicio de sesión. Inténtalo de nuevo.",
	"providerCallback.working": "Conectando con ChatGPT…",
	"providerCallback.success": "ChatGPT conectado",
	"providerCallback.error": "No se pudo conectar",
	"providerCallback.canClose": "Ya puedes cerrar esta ventana.",
	"providerCallback.retry": "Intentar de nuevo",
	"providerCallback.close": "Cerrar",
	"providerCallback.backToApp": "Volver a la app",
	"providerCallback.appTile": "App",
};
