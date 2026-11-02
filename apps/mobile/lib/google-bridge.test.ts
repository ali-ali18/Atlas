import { describe, expect, it } from "vitest";
import {
	LISTENER_GRACE_MS,
	PENDING_TTL_MS,
	appReturnUrl,
	base64UrlFromBase64,
	newCodeVerifier,
	bridgeStartUrl,
	createGoogleBridge,
	newBridgeState,
	readBridgeLink,
	type BridgeDeps,
	type PendingLogin,
} from "./google-bridge";

const STATE = "0123456789abcdef0123456789abcdef";
const TOKEN = "tok_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VERIFIER = "ab".repeat(32);
const CHALLENGE = "challenge_challenge_challenge_challenge_123";
const RETURN = "exp://u.expo.dev/abc/group/g1/--/";

describe("helpers puros", () => {
	it("PKCE: verifier de 64 hex e base64 → base64url sem preenchimento", () => {
		expect(newCodeVerifier(new Uint8Array(32).fill(1))).toBe("01".repeat(32));
		expect(base64UrlFromBase64("a+b/c==")).toBe("a-b_c");
	});
	it("newBridgeState dá 32 caracteres hexadecimais", () => {
		expect(newBridgeState(new Uint8Array(16).fill(255))).toBe("ff".repeat(16));
		expect(newBridgeState(Uint8Array.from([0, 1, 2]))).toBe("000102");
	});
	it("appReturnUrl aceita o deep link e recusa o site", () => {
		expect(appReturnUrl((p) => `exp://u.expo.dev/abc/--${p}`)).toBe("exp://u.expo.dev/abc/--/");
		expect(appReturnUrl(() => "atlas:///")).toBe("atlas:///");
		expect(() => appReturnUrl((p) => `https://agent.exemplo.com${p}`)).toThrow();
	});
	it("bridgeStartUrl codifica o retorno e não duplica a barra", () => {
		const url = bridgeStartUrl("https://agent.exemplo.com/", RETURN, STATE, CHALLENGE);
		expect(url).toBe(`https://agent.exemplo.com/api/mobile/auth/start?return=${encodeURIComponent(RETURN)}&state=${STATE}&code_challenge=${CHALLENGE}`);
	});
	it("readBridgeLink: token só com o state desta tentativa", () => {
		expect(readBridgeLink(`${RETURN}?token=${TOKEN}&state=${STATE}`, STATE)).toEqual({ kind: "token", token: TOKEN });
		expect(readBridgeLink(`atlas:///?state=${STATE}&token=${TOKEN}`, STATE)).toEqual({ kind: "token", token: TOKEN });
		expect(readBridgeLink(`${RETURN}?token=${TOKEN}&state=outro`, STATE)).toEqual({ kind: "other" });
		expect(readBridgeLink(`${RETURN}?token=${TOKEN}`, STATE)).toEqual({ kind: "other" });
		expect(readBridgeLink(RETURN, STATE)).toEqual({ kind: "other" });
	});
	it("readBridgeLink: erro do servidor e token malformado viram erro", () => {
		expect(readBridgeLink(`${RETURN}?error=access_denied&state=${STATE}`, STATE)).toEqual({ kind: "error" });
		expect(readBridgeLink(`${RETURN}?token=curto&state=${STATE}`, STATE)).toEqual({ kind: "error" });
		expect(readBridgeLink(`${RETURN}?token=%E0%A4%A&state=${STATE}`, STATE)).toEqual({ kind: "other" });
	});
});

function setup(overrides: Partial<BridgeDeps> = {}) {
	let pending: PendingLogin | null = null;
	let clock = 1_000_000;
	const exchanged: string[] = [];
	const verifiers: string[] = [];
	const opened: Array<{ url: string; returnUrl: string }> = [];
	const deps: BridgeDeps = {
		serverUrl: "https://agent.exemplo.com",
		returnUrl: RETURN,
		pending: {
			save: async (value) => void (pending = value),
			load: async () => pending,
			clear: async () => void (pending = null),
		},
		exchange: async (token, verifier) => {
			exchanged.push(token);
			verifiers.push(verifier);
			return true;
		},
		openAuthSession: async (url, returnUrl) => {
			opened.push({ url, returnUrl });
			return { type: "success", url: `${RETURN}?token=${TOKEN}&state=${STATE}` };
		},
		randomState: () => STATE,
		randomVerifier: () => VERIFIER,
		challengeOf: async () => CHALLENGE,
		now: () => clock,
		wait: async (ms) => void (clock += ms),
		...overrides,
	};
	return { bridge: createGoogleBridge(deps), deps, exchanged, verifiers, opened, getPending: () => pending, tick: (ms: number) => void (clock += ms) };
}

describe("createGoogleBridge", () => {
	it("abre o start com return e state, recebe o link, troca o token e esquece a tentativa", async () => {
		const t = setup();
		expect(await t.bridge.begin()).toBe("signed-in");
		expect(t.opened).toEqual([{ url: bridgeStartUrl("https://agent.exemplo.com", RETURN, STATE, CHALLENGE), returnUrl: RETURN }]);
		expect(t.exchanged).toEqual([TOKEN]);
		expect(t.verifiers).toEqual([VERIFIER]);
		expect(t.getPending()).toBeNull();
	});

	it("state diferente no link: não troca o token (CSRF) e o login termina como cancelado", async () => {
		const t = setup({ openAuthSession: async () => ({ type: "success", url: `${RETURN}?token=${TOKEN}&state=ffffffffffffffffffffffffffffffff` }) });
		expect(await t.bridge.begin()).toBe("cancelled");
		expect(t.exchanged).toEqual([]);
	});

	it("o mesmo link por dois caminhos (navegador e listener) só é trocado uma vez", async () => {
		let release: () => void = () => {};
		const t = setup({
			openAuthSession: async () => {
				await new Promise<void>((resolve) => (release = resolve));
				return { type: "success", url: `${RETURN}?token=${TOKEN}&state=${STATE}` };
			},
		});
		const begun = t.bridge.begin();
		await Promise.resolve();
		await Promise.resolve();
		const viaListener = await t.bridge.handleLink(`${RETURN}?token=${TOKEN}&state=${STATE}`);
		release();
		const viaBrowser = await begun;
		expect(viaListener).toBe("signed-in");
		expect(viaBrowser).toBe("ignored");
		expect(t.exchanged).toEqual([TOKEN]);
	});

	it("aba fechada sem link e sem listener: cancelado, sem erro", async () => {
		const t = setup({ openAuthSession: async () => ({ type: "dismiss" }) });
		expect(await t.bridge.begin()).toBe("cancelled");
		expect(t.exchanged).toEqual([]);
		expect(t.getPending()).toBeNull();
	});

	it("aba fechada e o link chega pelo listener durante a espera: conclui o login", async () => {
		let bridge: ReturnType<typeof createGoogleBridge> | null = null;
		const t = setup({
			openAuthSession: async () => ({ type: "dismiss" }),
			wait: async () => {
				expect(await bridge?.handleLink(`${RETURN}?token=${TOKEN}&state=${STATE}`)).toBe("signed-in");
			},
		});
		bridge = t.bridge;
		expect(await t.bridge.begin()).toBe("ignored");
		expect(t.exchanged).toEqual([TOKEN]);
	});

	it("erro do servidor (conta que não é do dono) vira falha, sem troca", async () => {
		const t = setup({ openAuthSession: async () => ({ type: "success", url: `${RETURN}?error=access_denied&state=${STATE}` }) });
		expect(await t.bridge.begin()).toBe("failed");
		expect(t.exchanged).toEqual([]);
		expect(t.getPending()).toBeNull();
	});

	it("troca recusada ou com falha de rede: falha", async () => {
		expect(await setup({ exchange: async () => false }).bridge.begin()).toBe("failed");
		expect(await setup({ exchange: async () => Promise.reject(new Error("rede")) }).bridge.begin()).toBe("failed");
	});

	it("o navegador não abrir: falha e a tentativa é apagada", async () => {
		const t = setup({ openAuthSession: async () => Promise.reject(new Error("sem navegador")) });
		expect(await t.bridge.begin()).toBe("failed");
		expect(t.getPending()).toBeNull();
	});

	it("link que reabre o app (sem a tela viva): handleLink retoma pela tentativa guardada", async () => {
		const t = setup({ openAuthSession: async () => ({ type: "dismiss" }), wait: async () => {} });
		await t.deps.pending.save({ state: STATE, verifier: VERIFIER, at: 1_000_000 });
		expect(await t.bridge.handleLink(`${RETURN}?token=${TOKEN}&state=${STATE}`)).toBe("signed-in");
		expect(await t.bridge.handleLink(`${RETURN}?token=${TOKEN}&state=${STATE}`)).toBe("ignored");
		expect(t.exchanged).toEqual([TOKEN]);
	});

	it("link sem tentativa pendente, ou depois do prazo, é ignorado", async () => {
		const t = setup();
		expect(await t.bridge.handleLink(`${RETURN}?token=${TOKEN}&state=${STATE}`)).toBe("ignored");
		await t.deps.pending.save({ state: STATE, verifier: VERIFIER, at: 1_000_000 });
		t.tick(PENDING_TTL_MS + 1);
		expect(await t.bridge.handleLink(`${RETURN}?token=${TOKEN}&state=${STATE}`)).toBe("ignored");
		expect(t.exchanged).toEqual([]);
		expect(LISTENER_GRACE_MS).toBeLessThan(5000);
	});
});
