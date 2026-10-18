import { authClient } from "@/lib/auth-client";

export const SIGN_OUT_ERROR = "Não foi possível sair. Tente novamente.";

/** Encerra a sessão e vai para o login. Devolve a mensagem de erro, ou `null` se saiu. */
export async function signOutAndRedirect(): Promise<string | null> {
	try {
		const result = await authClient.signOut();
		if (result.error) return SIGN_OUT_ERROR;
		window.location.replace("/login");
		return null;
	} catch {
		return SIGN_OUT_ERROR;
	}
}
