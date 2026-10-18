"use client";

import { useEffect, useRef, useState } from "react";
import type { BloubState } from "./data";

const WIDE_EYES = "yeux_ecarquilles" as const;
const IDLE_EXPRESSIONS: readonly BloubState[] = ["neutre", "curieux", "attentif"];
const WORKING_EXPRESSIONS: readonly BloubState[] = ["attentif", "curieux"];
const TAP_REACTION_MS = 700;

function delayBetween(minimum: number, maximum: number) {
	return minimum + Math.random() * (maximum - minimum);
}

export function usePreviewExpression({
	enabled = true,
	mode = "idle",
}: {
	enabled?: boolean;
	mode?: "idle" | "working";
} = {}) {
	const [idleExpression, setIdleExpression] = useState<BloubState>(
		mode === "working" ? "attentif" : "neutre",
	);
	const [gaze, setGaze] = useState(0);
	const [blink, setBlink] = useState(false);
	const [hovered, setHovered] = useState(false);
	const [tapped, setTapped] = useState(false);
	const [reducedMotion, setReducedMotion] = useState(false);
	const tapTimer = useRef<number | null>(null);

	useEffect(() => {
		const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setReducedMotion(preference.matches);
		update();
		preference.addEventListener("change", update);
		return () => preference.removeEventListener("change", update);
	}, []);

	useEffect(() => {
		return () => {
			if (tapTimer.current !== null) window.clearTimeout(tapTimer.current);
		};
	}, []);

	useEffect(() => {
		if (!enabled || reducedMotion || hovered || tapped) return;
		const expressions = mode === "working" ? WORKING_EXPRESSIONS : IDLE_EXPRESSIONS;
		let expressionTimer: number;
		let blinkTimer: number;
		let blinkEndTimer: number;

		const scheduleExpression = () => {
			expressionTimer = window.setTimeout(() => {
				setIdleExpression((previous) => {
					const choices = expressions.filter((expression) => expression !== previous);
					return choices[Math.floor(Math.random() * choices.length)] ?? expressions[0]!;
				});
				setGaze((previous) => {
					const choices = [-1.2, 0, 1.2].filter((value) => value !== previous);
					return choices[Math.floor(Math.random() * choices.length)] ?? 0;
				});
				scheduleExpression();
			}, delayBetween(6_000, 10_000));
		};
		const scheduleBlink = () => {
			blinkTimer = window.setTimeout(() => {
				setBlink(true);
				blinkEndTimer = window.setTimeout(() => {
					setBlink(false);
					scheduleBlink();
				}, 150);
			}, delayBetween(4_000, 9_000));
		};
		scheduleExpression();
		scheduleBlink();
		return () => {
			window.clearTimeout(expressionTimer);
			window.clearTimeout(blinkTimer);
			window.clearTimeout(blinkEndTimer);
			// O fim da piscada pode ter sido cancelado no meio do pulso.
			// Abra os olhos antes de iniciar outro ciclo.
			setBlink(false);
		};
	}, [enabled, hovered, mode, reducedMotion, tapped]);

	function surpriseOnHover(event: React.PointerEvent) {
		if (event.pointerType !== "mouse") return;
		setHovered(true);
		setBlink(false);
	}

	function releaseHover(event: React.PointerEvent) {
		if (event.pointerType !== "mouse") return;
		setHovered(false);
	}

	function surpriseOnTap() {
		if (tapTimer.current !== null) window.clearTimeout(tapTimer.current);
		setTapped(true);
		setBlink(false);
		tapTimer.current = window.setTimeout(() => {
			setTapped(false);
			tapTimer.current = null;
		}, TAP_REACTION_MS);
	}

	return {
		expression: !enabled
			? "neutre"
			: hovered || tapped
				? WIDE_EYES
				: reducedMotion
					? "neutre"
					: mode === "working" && idleExpression === "neutre"
						? "attentif"
						: idleExpression,
		blink: enabled && !reducedMotion && !hovered && !tapped && blink,
		gaze: enabled && !reducedMotion && !hovered && !tapped ? gaze : 0,
		surpriseOnHover,
		releaseHover,
		surpriseOnTap,
	};
}
