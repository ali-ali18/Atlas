"use client";

import { useCallback, useEffect, useState } from "react";
import { listProviders } from "@/lib/atlas-api";
import { useTranslations } from "@/lib/i18n/provider";
import {
	PROVIDER_CONNECTED_MESSAGE,
	PROVIDER_RETRY_MESSAGE,
	notifyProvidersChanged,
	type ProviderCallbackParams,
} from "@/lib/provider-connect";
import { providerLoginError } from "@/components/settings/providers-state";
import { ProviderCallbackView, type ProviderCallbackState } from "./provider-callback-view";

/** Tempo mostrando o sucesso antes de a janela fechar sozinha. */
const AUTO_CLOSE_MS = 1500;

/** Avisa o Atlas que abriu o popup; o `window.opener` só recebe na mesma origem. */
function postToOpener(type: string) {
	try {
		window.opener?.postMessage({ type, provider: "chatgpt" }, window.location.origin);
	} catch {
		/* Opener fechado ou de outra origem: o polling do Atlas cobre. */
	}
}

function openerAlive(): boolean {
	try {
		return !!window.opener && !window.opener.closed;
	} catch {
		return false;
	}
}

/** Estado do retorno do login: confirma na API, avisa o Atlas e fecha a janela. */
export function ProviderCallback({ params }: { params: ProviderCallbackParams }) {
	const [state, setState] = useState<ProviderCallbackState>(params.status === "ok" ? "working" : "error");
	const [email, setEmail] = useState<string | null>(null);
	const [hasOpener, setHasOpener] = useState(false);
	const translator = useTranslations();
	const message = providerLoginError(params.code, translator) ?? translator.t("providerCallback.genericError");

	useEffect(() => {
		setHasOpener(openerAlive());
		if (params.status !== "ok") return;
		const controller = new AbortController();
		void (async () => {
			let confirmed = true;
			try {
				const body = await listProviders(controller.signal);
				const chatgpt = body.providers.find((provider) => provider.provider === "chatgpt");
				if (chatgpt?.status !== "connected") confirmed = false;
				else setEmail(chatgpt.accountEmail);
			} catch {
				// Sem leitura do estado, o callback já concluiu: mostra sucesso sem e-mail.
			}
			if (controller.signal.aborted) return;
			setState(confirmed ? "success" : "error");
		})();
		return () => controller.abort();
	}, [params.status]);

	useEffect(() => {
		if (state !== "success") return;
		postToOpener(PROVIDER_CONNECTED_MESSAGE);
		notifyProvidersChanged();
		if (!openerAlive()) return;
		const timer = setTimeout(() => window.close(), AUTO_CLOSE_MS);
		return () => clearTimeout(timer);
	}, [state]);

	const retry = useCallback(() => {
		setState("working");
		postToOpener(PROVIDER_RETRY_MESSAGE);
	}, []);

	return (
		<ProviderCallbackView
			state={state}
			email={email}
			message={message}
			hasOpener={hasOpener}
			onRetry={retry}
			onClose={() => window.close()}
		/>
	);
}
