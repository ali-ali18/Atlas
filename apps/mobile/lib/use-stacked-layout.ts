import * as React from "react";
import { LayoutAnimation, Platform } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

import { textWrapped } from "@/lib/composer-metrics";

/**
 * Mecanismo único de "pílula → retângulo" do composer, usado pelo campo de texto e pela barra de voz: mede a altura do
 * conteúdo, guarda a menor altura vista (`baseline` = uma linha) e, quando o conteúdo passa dela em 80% de uma linha,
 * empilha. Fica empilhado até `reset` (sem vai e volta). `animate` é o LayoutAnimation do composer, que respeita reduced motion.
 */
export function useStackedLayout() {
	const reducedMotion = useReducedMotion();
	const [stacked, setStacked] = React.useState(false);
	const baseline = React.useRef<number | null>(null);
	const animate = React.useCallback(() => {
		if (!reducedMotion && Platform.OS !== "web") LayoutAnimation.configureNext(LayoutAnimation.create(180, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
	}, [reducedMotion]);
	/** Mede o conteúdo. Retorna true quando esta medida fez empilhar. `animated`: anima a troca. */
	const measure = (height: number, animated = false): boolean => {
		// A altura de uma linha varia por plataforma (com ou sem o padding): a menor medida é a base.
		if (baseline.current === null || height < baseline.current) {
			baseline.current = height;
			return false;
		}
		if (!textWrapped(height, baseline.current)) return false;
		if (animated && !stacked) animate();
		setStacked(true);
		return true;
	};
	/** Esvaziou: volta à pílula e mede a base de novo. */
	const reset = () => {
		setStacked(false);
		baseline.current = null;
	};
	/** A base de uma linha mudou (ex.: entrou o primeiro chip): mede de novo, sem desempilhar. */
	const resetBaseline = () => {
		baseline.current = null;
	};
	return { stacked, animate, measure, reset, resetBaseline };
}
