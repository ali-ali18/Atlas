// Olhos colados na superfície do corpo. Cada ponto do olho (plano da face) vira
// um ponto 3D sobre o sólido; depois a orientação gira tudo e a projeção
// descarta z. Funções puras, em "unidades de corpo" (raio do círculo = 1).
import { applyMat, type Mat3 } from "./math.js";

/**
 * Mapa exponencial da esfera: o olho é desenhado no plano tangente ao ponto
 * (u0, v0) da face (em radianos de arco) e enrolado na esfera. `local` são os
 * pontos do olho relativos ao seu centro, em raios da esfera, com y para cima.
 *   θ = |(g, h)|,  p = cos θ · M + (sen θ / θ) · (g · direita + h · cima)
 * M é o centro do olho na esfera; (direita, cima) é o referencial tangente em
 * M, transportado em paralelo desde o polo da frente (0, 0, 1).
 * Devolve [x0, y0, z0, x1, …] sobre a esfera unitária, antes da orientação.
 */
export function sphereEyePoints(
	local: ArrayLike<number>,
	centerU: number,
	centerV: number,
): number[] {
	const theta0 = Math.hypot(centerU, centerV);
	// Rodrigues: gira (1,0,0), (0,1,0) e (0,0,1) em torno de k = (-v, u, 0)/θ por θ.
	const ux = theta0 > 1e-9 ? -centerV / theta0 : 0;
	const uy = theta0 > 1e-9 ? centerU / theta0 : 0;
	const c = Math.cos(theta0);
	const s = Math.sin(theta0);
	const rotate = (x: number, y: number, z: number): [number, number, number] => {
		// k × v, com k = (ux, uy, 0)
		const cx = uy * z;
		const cy = -ux * z;
		const cz = ux * y - uy * x;
		const dot = ux * x + uy * y;
		return [
			x * c + cx * s + ux * dot * (1 - c),
			y * c + cy * s + uy * dot * (1 - c),
			z * c + cz * s,
		];
	};
	const right = rotate(1, 0, 0);
	const up = rotate(0, 1, 0);
	const center = rotate(0, 0, 1);
	const out: number[] = [];
	for (let i = 0; i < local.length; i += 2) {
		const g = local[i] as number;
		const h = local[i + 1] as number;
		const phi = Math.hypot(g, h);
		const sinc = phi > 1e-9 ? Math.sin(phi) / phi : 1;
		const cosPhi = Math.cos(phi);
		out.push(
			cosPhi * center[0] + sinc * (g * right[0] + h * up[0]),
			cosPhi * center[1] + sinc * (g * right[1] + h * up[1]),
			cosPhi * center[2] + sinc * (g * right[2] + h * up[2]),
		);
	}
	return out;
}

/**
 * Gira os pontos 3D por `m` e descarta os de trás: pontos com z < 0 (atrás do
 * limbo) são levados ao limbo (círculo unitário), de modo que o olho encosta na
 * borda em vez de sumir de repente. Se TODOS estão atrás, o olho está oculto
 * (`null`). Devolve [x0, y0, x1, …] em unidades de corpo (y para cima).
 */
export function projectSpherePoints(points: ArrayLike<number>, m: Mat3): number[] | null {
	const out: number[] = [];
	let visible = false;
	for (let i = 0; i < points.length; i += 3) {
		const p = applyMat(m, points[i] as number, points[i + 1] as number, points[i + 2] as number);
		if (p[2] >= 0) {
			visible = true;
			out.push(p[0], p[1]);
			continue;
		}
		const len = Math.hypot(p[0], p[1]) || 1;
		out.push(p[0] / len, p[1] / len);
	}
	return visible ? out : null;
}
