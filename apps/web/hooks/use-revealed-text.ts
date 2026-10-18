"use client";

import { useEffect, useRef, useState } from "react";

function prefersReducedMotion(): boolean {
	if (typeof window === "undefined") return false;
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function charsThisFrame(remaining: number): number {
	if (remaining > 400) return Math.ceil(remaining / 5);
	if (remaining > 120) return 10;
	if (remaining > 40) return 5;
	return 2;
}

/** Revela texto em rajada como se estivesse chegando token a token. */
export function useRevealedText(text: string, live: boolean): string {
	const [shown, setShown] = useState(live ? "" : text);
	const shownRef = useRef(shown);
	shownRef.current = shown;

	useEffect(() => {
		if (!live || prefersReducedMotion()) {
			setShown(text);
			return;
		}

		if (text.length <= shownRef.current.length) {
			setShown(text);
			return;
		}

		// Stream real (token a token): mostra na hora. Só anima rajada grande.
		if (text.length - shownRef.current.length <= 24) {
			setShown(text);
			return;
		}

		let frame = 0;
		const step = () => {
			const current = shownRef.current;
			if (text.length <= current.length) {
				setShown(text);
				return;
			}
			const nextLen = Math.min(
				text.length,
				current.length + charsThisFrame(text.length - current.length),
			);
			setShown(text.slice(0, nextLen));
			if (nextLen < text.length) {
				frame = window.requestAnimationFrame(step);
			}
		};

		frame = window.requestAnimationFrame(step);
		return () => window.cancelAnimationFrame(frame);
	}, [live, text]);

	return live ? shown : text;
}
