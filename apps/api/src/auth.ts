// Fase 0: dotenv ANTES de qualquer outro import (ver index.ts).
import "dotenv/config";
import { expo } from "@better-auth/expo";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { prisma } from "@workspace/db";
import { sendMail, type MailMessage } from "@workspace/mail";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP, magicLink } from "better-auth/plugins";
import { createEmailCodeLimiter, type EmailCodeLimiter } from "./auth-email-limit.js";

const ownerEmail = process.env.ATLAS_OWNER_EMAIL?.trim().toLowerCase();
if (!ownerEmail) throw new Error("ATLAS_OWNER_EMAIL is required");

const authSecret = process.env.BETTER_AUTH_SECRET?.trim();
if (!authSecret) throw new Error("BETTER_AUTH_SECRET is required");

const atlasUrl = process.env.ATLAS_URL?.trim();
if (!atlasUrl && process.env.NODE_ENV === "production") {
	throw new Error("ATLAS_URL is required in production");
}
const baseURL = new URL(atlasUrl || "http://localhost:3000");
if (!(["http:", "https:"].includes(baseURL.protocol)) || baseURL.pathname !== "/" || baseURL.search || baseURL.hash) {
	throw new Error("ATLAS_URL must be an origin without path, query or fragment");
}

export const authProviders = {
	github: Boolean(process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET),
	google: Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET),
};

const socialProviders = {
	...(process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET
		? {
			github: {
				clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
				clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
			},
		}
		: {}),
	...(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET
		? {
			google: {
				clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
				clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
			},
		}
		: {}),
};

/** Esquema do app mobile (`scheme` em apps/mobile/app.json). Só este app o recebe de volta no login. */
export const MOBILE_APP_ORIGIN = "atlas://";
/** Retorno do login no Expo Go (`exp://<ip>:<porta>/...`). Qualquer app no Expo Go consegue abrir esse esquema. */
export const EXPO_GO_ORIGIN = "exp://";

/**
 * Origens que podem receber o retorno do login e enviar POST com `Origin`. `atlas://` entra sempre; `exp://` só com
 * `ATLAS_TRUST_EXPO_GO=1` (teste no Expo Go): em produção, outro app no Expo Go poderia ser o destino do retorno
 * do Google e levar a sessão. Função pura, testada.
 */
export function buildTrustedOrigins(webOrigin: string, trustExpoGo: boolean): string[] {
	return [webOrigin, MOBILE_APP_ORIGIN, ...(trustExpoGo ? [EXPO_GO_ORIGIN] : [])];
}

/** Código de acesso por e-mail: curto, de uso único e com poucas tentativas. */
export const EMAIL_OTP_LENGTH = 6;
export const EMAIL_OTP_EXPIRES_IN_SECONDS = 300;
export const EMAIL_OTP_ALLOWED_ATTEMPTS = 5;

export type AuthDeps = {
	database?: BetterAuthOptions["database"];
	/** Envio de e-mail (injetável nos testes). */
	mail?: (message: MailMessage) => Promise<unknown>;
	trustExpoGo?: boolean;
	rateLimit?: BetterAuthOptions["rateLimit"];
	/** Teto de códigos por e-mail de destino (injetável nos testes). */
	emailLimiter?: EmailCodeLimiter;
};

export function createAuth(deps: AuthDeps = {}) {
	const mail = deps.mail ?? sendMail;
	const emailLimiter = deps.emailLimiter ?? createEmailCodeLimiter();
	const trustExpoGo = deps.trustExpoGo ?? process.env.ATLAS_TRUST_EXPO_GO?.trim() === "1";
	const authOptions = {
		baseURL: baseURL.origin,
		secret: authSecret,
		database: deps.database ?? prismaAdapter(prisma, { provider: "postgresql" }),
		trustedOrigins: buildTrustedOrigins(baseURL.origin, trustExpoGo),
		...(deps.rateLimit ? { rateLimit: deps.rateLimit } : {}),
		// Sem cookieCache: com ele ligado o login (Google e link por e-mail) travou na criação da sessão em produção.
		// Volta a ligar só com teste do fluxo completo de login.
		session: { cookieCache: { enabled: false } },
		// Erro no login (estado vencido, callback repetido) volta para a tela de login em vez de um 500 cru.
		onAPIError: { errorURL: "/login" },
		// disableOriginCheck explícito: em NODE_ENV=test o better-auth desliga a checagem de origem sozinho e os testes não a veriam.
		advanced: { useSecureCookies: baseURL.protocol === "https:", disableOriginCheck: false },
		socialProviders,
		user: {
			validateUserInfo: ({ user }: { user: { email?: string | null } }) =>
				user.email?.trim().toLowerCase() === ownerEmail
					? undefined
					: { error: "email_not_allowed", errorDescription: "Esta conta não tem acesso ao Atlas" },
		},
		databaseHooks: {
			user: {
				create: {
					// Ninguém além do dono vira usuário, qualquer que seja o caminho (Google, link, código).
					before: async (user: { email?: string | null }) => {
						if (!isOwnerEmail(user.email ?? "")) {
							throw new APIError("FORBIDDEN", { message: "Esta conta não tem acesso ao Atlas" });
						}
					},
				},
			},
		},
		plugins: [
			// Troca o cabeçalho `expo-origin` do app por `Origin` e devolve o cookie da sessão ao app no retorno do Google.
			expo(),
			{
				id: "atlas-owner-only-otp",
				hooks: {
					before: [
						{
							matcher: (context: { path?: string }) => context.path === "/email-otp/send-verification-otp",
							// Resposta neutra: e-mail que não é do dono recebe o mesmo `{ success: true }`, sem código gravado
							// nem e-mail enviado, então não dá para descobrir quem é o dono. Estourou o teto por e-mail:
							// também neutra, sem código (quem pede demais não aprende nada e a caixa do dono não enche).
							handler: createAuthMiddleware(async (ctx) => {
								const email = typeof ctx.body?.email === "string" ? ctx.body.email : "";
								if (!isOwnerEmail(email) || !emailLimiter.allow(email)) return ctx.json({ success: true });
							}),
						},
					],
				},
			},
			emailOTP({
				otpLength: EMAIL_OTP_LENGTH,
				expiresIn: EMAIL_OTP_EXPIRES_IN_SECONDS,
				allowedAttempts: EMAIL_OTP_ALLOWED_ATTEMPTS,
				storeOTP: "hashed",
				async sendVerificationOTP({ email, otp, type }) {
					// Só o código de entrada; os outros tipos (senha, troca de e-mail) não existem no Atlas.
					if (type !== "sign-in" || !isOwnerEmail(email)) return;
					// Sem `await`: a resposta não espera o SMTP, então o tempo é o mesmo para o dono e para os outros
					// e-mails (que nem chegam aqui). Falha de envio vai ao log sem o código.
					void mail({
						to: email,
						subject: "Seu código de acesso ao Atlas",
						text: `Seu código para entrar no Atlas: ${otp}\n\nEle vale por 5 minutos. Se não foi você, ignore este e-mail.`,
						html: `<p>Seu código para entrar no Atlas:</p><p style="font-size:24px;letter-spacing:4px"><strong>${otp}</strong></p><p>Ele vale por 5 minutos. Se não foi você, ignore este e-mail.</p>`,
					}).catch((error: unknown) => {
						console.error("[auth] falha ao enviar o código de acesso:", error instanceof Error ? error.name : "erro");
					});
				},
			}),
			magicLink({
				async sendMagicLink({ email, url }) {
					if (email.trim().toLowerCase() !== ownerEmail) {
						throw new APIError("FORBIDDEN", { message: "Esta conta não tem acesso ao Atlas" });
					}
					await mail({
						to: email,
						subject: "Entre no Atlas",
						text: `Abra este link para entrar no Atlas: ${url}`,
						html: `<p>Abra este link para entrar no Atlas:</p><p><a href="${url}">Entrar no Atlas</a></p>`,
					});
				},
			}),
		],
	} satisfies BetterAuthOptions;
	return betterAuth(authOptions);
}

export const auth = createAuth();

export function isOwnerEmail(email: string): boolean {
	return email.trim().toLowerCase() === ownerEmail;
}

export type AuthSession = typeof auth.$Infer.Session;
