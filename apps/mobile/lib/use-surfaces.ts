import { type SurfaceColors, surfaceColors } from "./surfaces";
import { useAppColorScheme } from "./use-theme";

/** Cores da pele do app para o tema atual (ver `lib/surfaces.ts`). */
export function useSurfaces(): SurfaceColors {
	return surfaceColors(useAppColorScheme());
}
