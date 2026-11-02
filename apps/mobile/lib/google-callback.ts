/**
 * URLs de retorno do login com Google no app: sempre deep link absoluto (atlas://… ou exp://… no Expo Go), nunca
 * caminho relativo. Com "/" o servidor redirecionava para o site dentro do navegador e a sessão não voltava ao app.
 */
export function googleCallbackUrls(createURL: (path: string) => string): { callbackURL: string; errorCallbackURL: string; newUserCallbackURL: string } {
	const home = createURL("/");
	if (/^https?:/i.test(home)) throw new Error("O retorno do login precisa ser o link do app, não o site.");
	return { callbackURL: home, errorCallbackURL: createURL("/login"), newUserCallbackURL: home };
}
