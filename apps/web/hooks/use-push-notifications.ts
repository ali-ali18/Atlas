"use client";

import { useCallback, useEffect, useState } from "react";
import {
	getPushConfig,
	listPushDevices,
	removePushDevice,
	savePushDevice,
	sendPushTest,
	unsubscribePushEndpoint,
	type PushDevice,
} from "@/lib/atlas-api";
import { pushState, readPushEnv, urlBase64ToUint8Array, type PushState } from "@/lib/push-client";

export type PushNotifications = {
	loading: boolean;
	state: PushState;
	devices: PushDevice[];
	/** Id do aparelho deste navegador na lista (para marcar "Este aparelho"). */
	currentDeviceId: string | null;
	busy: boolean;
	error: string | null;
	notice: string | null;
	enable: () => Promise<void>;
	disable: () => Promise<void>;
	test: () => Promise<void>;
	remove: (id: string) => Promise<void>;
};

async function currentSubscription(): Promise<PushSubscription | null> {
	if (!("serviceWorker" in navigator)) return null;
	const registration = await navigator.serviceWorker.ready;
	return registration.pushManager.getSubscription();
}

/** Estado e ações da seção "Notificações no celular" (conta). */
export function usePushNotifications(): PushNotifications {
	const [loading, setLoading] = useState(true);
	const [serverEnabled, setServerEnabled] = useState(false);
	const [publicKey, setPublicKey] = useState<string | null>(null);
	const [devices, setDevices] = useState<PushDevice[]>([]);
	const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
	const [subscribed, setSubscribed] = useState(false);
	const [permissionTick, setPermissionTick] = useState(0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const config = await getPushConfig();
			setServerEnabled(config.enabled);
			setPublicKey(config.publicKey);
			const [list, subscription] = await Promise.all([listPushDevices(), currentSubscription().catch(() => null)]);
			setDevices(list.devices);
			const mine = subscription ? list.endpoints.find((entry) => entry.endpoint === subscription.endpoint) : undefined;
			setCurrentDeviceId(mine?.id ?? null);
			setSubscribed(Boolean(mine));
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Não foi possível carregar as notificações.");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function run(action: () => Promise<string | null>) {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			setNotice(await action());
		} catch (cause) {
			setError(cause instanceof Error && cause.message ? cause.message : "Algo deu errado. Tente de novo.");
		} finally {
			setPermissionTick((tick) => tick + 1);
			setBusy(false);
		}
	}

	const enable = () =>
		run(async () => {
			if (!publicKey) throw new Error("As notificações ainda não foram configuradas no servidor.");
			const permission = await Notification.requestPermission();
			if (permission !== "granted") throw new Error("Permissão negada. Libere as notificações nas configurações do navegador.");
			const registration = await navigator.serviceWorker.ready;
			const subscription =
				(await registration.pushManager.getSubscription()) ??
				(await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
			await savePushDevice(subscription.toJSON());
			await refresh();
			return "Notificações ativadas neste aparelho.";
		});

	const disable = () =>
		run(async () => {
			const subscription = await currentSubscription();
			if (subscription) {
				await unsubscribePushEndpoint(subscription.endpoint).catch(() => undefined);
				await subscription.unsubscribe().catch(() => undefined);
			}
			await refresh();
			return "Notificações desativadas neste aparelho.";
		});

	const test = () =>
		run(async () => {
			const result = await sendPushTest();
			await refresh();
			return result.sent > 0 ? "Enviamos uma notificação de teste." : "Não foi possível entregar o teste. Tente ativar de novo.";
		});

	const remove = (id: string) =>
		run(async () => {
			const isMine = id === currentDeviceId;
			await removePushDevice(id);
			if (isMine) await (await currentSubscription())?.unsubscribe().catch(() => undefined);
			await refresh();
			return "Aparelho removido.";
		});

	// `permissionTick` força reler Notification.permission depois de cada ação.
	void permissionTick;
	const state = loading ? "off" : pushState(readPushEnv({ serverEnabled, subscribed }));
	return { loading, state, devices, currentDeviceId, busy, error, notice, enable, disable, test, remove };
}
