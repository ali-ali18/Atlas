import { expect, it } from "vitest";
import { buildRuntimeCheckpoint, parseRuntimeCheckpoint } from "./checkpoint.js";
it("pedido de login Composio atravessa JSON sem alterar login antigo", () => {
 const pendingLogin = { loginId: "login-a", site: "linear", url: "https://composio.dev", composioToolkit: "linear" };
 const checkpoint = buildRuntimeCheckpoint({ messages: [], conversation: [], nextStepIndex: 1, model: "m", pendingLogin });
 expect(parseRuntimeCheckpoint(JSON.parse(JSON.stringify(checkpoint)))?.pendingLogin).toEqual(pendingLogin);
 const { composioToolkit, ...old } = pendingLogin;
 expect(parseRuntimeCheckpoint({ messages: [], pendingLogin: old })?.pendingLogin).toEqual(old);
});

it("pedido de login de conector nativo guarda ícone, nome e descrição no checkpoint", () => {
	const connector = { kind: "native" as const, id: "github", name: "GitHub", description: "Repositórios", icon: "/connectors/github.svg", reconnect: true };
	const pendingLogin = { loginId: "login-b", site: "GitHub", url: "https://github.com", connector };
	const checkpoint = buildRuntimeCheckpoint({ messages: [], conversation: [], nextStepIndex: 1, model: "m", pendingLogin });
	expect(parseRuntimeCheckpoint(JSON.parse(JSON.stringify(checkpoint)))?.pendingLogin).toEqual(pendingLogin);
	const forged = { ...pendingLogin, connector: { ...connector, icon: "javascript:x" } };
	expect(parseRuntimeCheckpoint({ messages: [], pendingLogin: forged })?.pendingLogin?.connector?.icon).toBeNull();
});

it("oferta do Cofre e o 'Entrar' sobrevivem ao checkpoint; senha/campos extras são descartados", () => {
	const pendingLogin = { loginId: "login-v", site: "chatgpt.com", url: "https://chatgpt.com/auth/login", vault: { name: "chatgpt", label: "ChatGPT", username: "a@x.com", domain: "chatgpt.com" }, useVault: true, vaultTried: "mais um passo" };
	const checkpoint = buildRuntimeCheckpoint({ messages: [], conversation: [], nextStepIndex: 1, model: "m", pendingLogin });
	expect(parseRuntimeCheckpoint(JSON.parse(JSON.stringify(checkpoint)))?.pendingLogin).toEqual(pendingLogin);
	const dirty = parseRuntimeCheckpoint({ messages: [], pendingLogin: { ...pendingLogin, vault: { ...pendingLogin.vault, password: "x" }, useVault: "sim" } });
	expect(dirty?.pendingLogin?.vault).toEqual(pendingLogin.vault);
	expect(dirty?.pendingLogin?.useVault).toBeUndefined();
});
