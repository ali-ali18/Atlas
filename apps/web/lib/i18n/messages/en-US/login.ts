import type { login as ptBR } from "../pt-BR/login";
import type { NamespaceMessages } from "../../translator";

export const login: NamespaceMessages<typeof ptBR> = {
	"login.title": "Sign in to Atlas",
	"login.subtitle": "Your personal agent on your own server.",
	"login.google": "Continue with Google",
	"login.github": "Continue with GitHub",
	"login.or": "or",
	"login.emailLabel": "Email",
	"login.emailPlaceholder": "you@example.com",
	"login.sendLink": "Email me a sign-in link",
	"login.linkSent": "Check your email for the link.",
	"login.privateInstance": "Private instance — only the owner has access.",
	"login.startError": "Couldn't start sign-in.",
	"login.linkError": "Couldn't send the link.",
	"login.quote": "An AI agent <em>made your way</em>: bots, routines and connectors working for you.",
	"login.avatarLabel": "Atlas Agent avatar",
	"login.tagline": "Your AI, your way",
	"login.allInOnePlace": "Everything in one place",
	"login.language": "Language",
};
