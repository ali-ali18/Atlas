import type { CSSProperties } from "react";
import { cn } from "@workspace/ui/lib/utils";
import { getChartLocale } from "../charts/chart-formatters";

/** Hash FNV-1a de 32 bits: estável entre sessões, máquinas e versões. */
function hash(seed: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < seed.length; i += 1) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

export type AvatarGradient = {
	deepHue: number;
	midHue: number;
	lightHue: number;
	/** Ângulo (graus, 0 = onde fica a cor profunda) que o centro do avatar, onde fica a letra, ocupa no cone. */
	centerAngle: number;
	background: string;
};

/**
 * Redemoinho determinístico para um id/e-mail: `conic-gradient` com um lado de cor profunda
 * (L 30-38%), uma transição estreita (L 45-50%) e um lado claro e saturado (L 55-62%), com os
 * matizes a ~140-180 graus um do outro. O cone é descentralizado e girado para que o centro
 * (a letra escura) caia sempre na parte clara; um radial leve esconde a ponta do cone.
 */
export function avatarGradient(seed: string): AvatarGradient {
	const h = hash(seed.trim().toLowerCase() || "?");
	const deepHue = h % 360;
	const lightHue = (deepHue + 140 + ((h >>> 9) % 41)) % 360; // 140..180 de distância
	const midHue = (deepHue - 35 - ((h >>> 14) % 25) + 360) % 360; // entre a profunda e a clara, do lado da profunda
	const deepSat = 80 + ((h >>> 3) % 11);
	const deepLight = 30 + ((h >>> 5) % 9);
	const lightSat = 75 + ((h >>> 7) % 16);
	const lightLight = 55 + ((h >>> 11) % 8) + (lightHue >= 200 && lightHue <= 300 ? 12 : 0); // azuis/violetas parecem mais escuros: sobe a luminosidade
	// Centro do cone deslocado (35-45% do lado) em um dos quatro quadrantes.
	const off = 35 + ((h >>> 16) % 11);
	const cx = (h >>> 20) % 2 === 0 ? off : 100 - off;
	const cy = (h >>> 21) % 2 === 0 ? off : 100 - off;
	// Direção do cone até o centro do avatar (0 = para cima, sentido horário).
	const toCenter = ((Math.atan2(50 - cx, cy - 50) * 180) / Math.PI + 360) % 360;
	const jitter = ((h >>> 24) % 41) - 20; // -20..20
	const from = Math.round(((toCenter - 180 + jitter) % 360 + 360) % 360);
	const centerAngle = Math.round(((toCenter - from) % 360 + 360) % 360);
	const deep = `hsl(${deepHue} ${deepSat}% ${deepLight}%)`;
	const mid = `hsl(${midHue} 85% 48%)`;
	const light = `hsl(${lightHue} ${lightSat}% ${lightLight}%)`;
	const light2 = `hsl(${(lightHue + 12) % 360} ${lightSat}% ${lightLight - 3}%)`;
	const background = [
		`radial-gradient(circle at ${cx}% ${cy}%, hsl(${midHue} 85% 48% / 0.9) 0%, hsl(${midHue} 85% 48% / 0) 38%)`,
		`conic-gradient(from ${from}deg at ${cx}% ${cy}%, ${deep} 0deg, ${mid} 70deg, ${light} 125deg, ${light2} 260deg, ${deep} 360deg)`,
	].join(", ");
	return { deepHue, midHue, lightHue, centerAngle, background };
}

/** Primeira letra do nome; sem nome, a do e-mail; sem nenhum, "?". */
export function avatarInitial(name?: string | null, email?: string | null, locale: string = getChartLocale()): string {
	const first = [...((name ?? "").trim() || (email ?? "").trim())][0];
	return first ? first.toLocaleUpperCase(locale) : "?";
}

/** Foto do usuário ou, sem foto, a inicial escura do nome sobre um gradiente mesh derivado de `seed`. */
export function UserAvatar({
	image,
	seed,
	name,
	email,
	size = 40,
	className,
}: {
	image?: string | null;
	/** Id ou e-mail do usuário: o mesmo valor sempre dá o mesmo gradiente. */
	seed: string;
	name?: string | null;
	email?: string | null;
	/** Lado em pixels. */
	size?: number;
	className?: string;
}) {
	const box: CSSProperties = { width: size, height: size };
	if (image) {
		return (
			// Data URL pequeno guardado no usuário: next/image não otimiza isso.
			// eslint-disable-next-line @next/next/no-img-element
			<img alt="" className={cn("shrink-0 rounded-full object-cover", className)} data-slot="user-avatar" src={image} style={box} />
		);
	}
	return (
		<span
			aria-hidden
			className={cn("relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold select-none", className)}
			data-gradient=""
			data-slot="user-avatar"
			style={{ ...box, fontSize: Math.round(size * 0.42), lineHeight: 1, color: "rgb(10 10 10 / 0.9)" }}
		>
			<span
				className="absolute inset-0"
				data-slot="user-avatar-swirl"
				style={{ background: avatarGradient(seed).background, filter: `blur(${Math.max(1, Math.round(size * 0.05))}px)`, transform: "scale(1.3)" }}
			/>
			<span className="relative">{avatarInitial(name, email ?? seed)}</span>
		</span>
	)
}
