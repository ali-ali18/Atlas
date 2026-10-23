"use client";

import dynamic from "next/dynamic";
import { type ComponentProps, useEffect, useState } from "react";

import { useSettingsSection } from "./settings-url";

// O modal das Configurações (e todas as seções) só é baixado quando abre pela primeira vez.
const SettingsDialog = dynamic(() => import("./settings-dialog").then((mod) => mod.SettingsDialog), { ssr: false });

/**
 * Monta o modal só depois que `?settings=` aparece na URL (e o mantém montado depois, para a animação de
 * fechar e a volta rápida). Fechado desde o início, nada do modal entra no bundle inicial.
 */
export function LazySettingsDialog(props: ComponentProps<typeof SettingsDialog>) {
	const { section } = useSettingsSection();
	const [opened, setOpened] = useState(section !== null);
	useEffect(() => {
		if (section !== null) setOpened(true);
	}, [section]);
	return opened || section !== null ? <SettingsDialog {...props} /> : null;
}
