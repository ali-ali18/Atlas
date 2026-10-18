"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	disconnectChatgptProvider,
	pollChatgptDeviceLogin,
	startChatgptDeviceLogin,
	type ChatgptDeviceStart,
} from "@/lib/atlas-api";
import { notifyProvidersChanged } from "@/lib/provider-connect";

export type DeviceCodeState = Pick<ChatgptDeviceStart, "userCode" | "verificationUrl" | "expiresAt">;

/**
 * Conectar (login por código de dispositivo, sem redirect) e desconectar a conta.
 * O servidor consulta a OpenAI; aqui só perguntamos pelo resultado no ritmo pedido.
 */
export function useChatgptConnection() {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [device, setDevice] = useState<DeviceCodeState | null>(null);
	const [expired, setExpired] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const runRef = useRef(0);

	const stop = useCallback(() => {
		runRef.current += 1;
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = null;
	}, []);
	useEffect(() => stop, [stop]);

	const connect = useCallback(async () => {
		stop();
		const run = runRef.current;
		setBusy(true);
		setError(null);
		setNotice(null);
		setExpired(false);
		function schedule(seconds: number) {
			timerRef.current = setTimeout(async () => {
				if (run !== runRef.current) return;
				try {
					const result = await pollChatgptDeviceLogin();
					if (run !== runRef.current) return;
					if (result.status === "pending") return schedule(result.intervalSeconds);
					stop();
					setDevice(null);
					if (result.status === "connected") notifyProvidersChanged();
					else setExpired(true);
				} catch {
					if (run !== runRef.current) return;
					stop();
					setDevice(null);
					setError("O login não foi concluído. Gere um novo código e tente de novo.");
				}
			}, seconds * 1000);
		}
		try {
			const started = await startChatgptDeviceLogin();
			if (run !== runRef.current) return;
			setDevice({ userCode: started.userCode, verificationUrl: started.verificationUrl, expiresAt: started.expiresAt });
			schedule(started.intervalSeconds);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Não foi possível conectar o ChatGPT.");
		} finally {
			setBusy(false);
		}
	}, [stop]);

	const cancel = useCallback(() => {
		stop();
		setDevice(null);
		setExpired(false);
	}, [stop]);

	const disconnect = useCallback(async () => {
		stop();
		setDevice(null);
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const response = await disconnectChatgptProvider();
			if (!response.revocationConfirmed)
				setNotice(
					"Desconectado do Atlas. A revogação na OpenAI não foi confirmada; confira os acessos nas configurações do ChatGPT.",
				);
			notifyProvidersChanged();
		} catch {
			setError("Não foi possível desconectar o ChatGPT. Tente novamente.");
		} finally {
			setBusy(false);
		}
	}, [stop]);

	return { busy, error, notice, device, expired, connect, cancel, disconnect };
}
