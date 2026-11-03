import { atlasOrigin, auth } from "./auth.js";
import { createOAuthHandoff, type OAuthHandoff } from "./mobile-oauth-handoff.js";

let instance: OAuthHandoff | undefined;

/** Gerador de produção (better-auth real + ATLAS_URL). Testes injetam o deles pelas opções das rotas. */
export function defaultOAuthHandoff(): OAuthHandoff {
	instance ??= createOAuthHandoff({ auth, baseOrigin: atlasOrigin });
	return instance;
}
