import { authClient } from "@/lib/auth-client";
import { activeT } from "@/lib/i18n/active";

const signOutError = () => activeT("errors.signOut");

/** Encerra a sessão e vai para o login. Devolve a mensagem de erro, ou `null` se saiu. */
export async function signOutAndRedirect(): Promise<string | null> {
	try {
		const result = await authClient.signOut();
		if (result.error) return signOutError();
		window.location.replace("/login");
		return null;
	} catch {
		return signOutError();
	}
}
