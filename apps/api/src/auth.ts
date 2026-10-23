// Fase 0: dotenv ANTES de qualquer outro import (ver index.ts).
import "dotenv/config";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { prisma } from "@workspace/db";
import { sendMail } from "@workspace/mail";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { magicLink } from "better-auth/plugins";

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

const authOptions: BetterAuthOptions = {
	baseURL: baseURL.origin,
	secret: authSecret,
	database: prismaAdapter(prisma, { provider: "postgresql" }),
	trustedOrigins: [baseURL.origin],
	// Sessão assinada num cookie por 5 min: o requireUser não vai ao banco a cada requisição. Contrapartida
	// (decidida pelo dono): sessão revogada no servidor ainda vale até o cookie expirar; sair (sign-out) apaga o cookie.
	session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
	advanced: { useSecureCookies: baseURL.protocol === "https:" },
	socialProviders,
	user: {
		validateUserInfo: ({ user }) =>
			user.email?.trim().toLowerCase() === ownerEmail
				? undefined
				: { error: "email_not_allowed", errorDescription: "Esta conta não tem acesso ao Atlas" },
	},
	plugins: [
		magicLink({
			async sendMagicLink({ email, url }) {
				if (email.trim().toLowerCase() !== ownerEmail) {
					throw new APIError("FORBIDDEN", { message: "Esta conta não tem acesso ao Atlas" });
				}
				await sendMail({
					to: email,
					subject: "Entre no Atlas",
					text: `Abra este link para entrar no Atlas: ${url}`,
					html: `<p>Abra este link para entrar no Atlas:</p><p><a href="${url}">Entrar no Atlas</a></p>`,
				});
			},
		}),
	],
};

export const auth = betterAuth(authOptions);

export function isOwnerEmail(email: string): boolean {
	return email.trim().toLowerCase() === ownerEmail;
}

export type AuthSession = typeof auth.$Infer.Session;
