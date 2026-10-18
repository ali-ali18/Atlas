"use client";

import { useEffect, useState } from "react";

/** A aba está visível e a janela em foco? Só então o usuário está de fato vendo a conversa. */
export function useWindowAttention(): boolean {
	const read = () =>
		typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
	const [attentive, setAttentive] = useState(read);
	useEffect(() => {
		const update = () => setAttentive(read());
		update();
		document.addEventListener("visibilitychange", update);
		window.addEventListener("focus", update);
		window.addEventListener("blur", update);
		return () => {
			document.removeEventListener("visibilitychange", update);
			window.removeEventListener("focus", update);
			window.removeEventListener("blur", update);
		};
	}, []);
	return attentive;
}
