"use client";

import { useEffect, useState } from "react";

/** A aba está visível? (`visibilitychange`). No servidor, conta como visível. */
export function useDocumentVisible(): boolean {
	const read = () => typeof document === "undefined" || document.visibilityState !== "hidden";
	const [visible, setVisible] = useState(read);
	useEffect(() => {
		const update = () => setVisible(read());
		update();
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	return visible;
}
