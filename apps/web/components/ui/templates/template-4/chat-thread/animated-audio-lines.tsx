import { cn } from "@workspace/ui/lib/utils";

// Mesmas barras do `audio-lines` do lucide; cada uma ganha duração e atraso próprios.
const BARS = [
	{ d: "M2 10v3", delay: 0, duration: 900 },
	{ d: "M6 6v11", delay: 150, duration: 750 },
	{ d: "M10 3v18", delay: 300, duration: 1000 },
	{ d: "M14 8v7", delay: 75, duration: 820 },
	{ d: "M18 5v13", delay: 225, duration: 950 },
	{ d: "M22 10v3", delay: 375, duration: 780 },
] as const;

// Keyframes locais: o app não tem CSS próprio e o ícone é o único consumidor.
const CSS = `
@keyframes atlas-audio-bar{0%,100%{transform:scaleY(.35)}50%{transform:scaleY(1)}}
.atlas-audio-bar{transform-box:fill-box;transform-origin:center;animation:atlas-audio-bar ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.atlas-audio-bar{animation:none}}
`;

/** Ícone `audio-lines` com cada barra subindo e descendo em ritmos defasados (medidor ao vivo). */
export function AnimatedAudioLines({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			className={cn("size-4", className)}
			data-slot="animated-audio-lines"
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth={2}
			viewBox="0 0 24 24"
			xmlns="http://www.w3.org/2000/svg"
		>
			<style>{CSS}</style>
			{BARS.map((bar) => (
				<path
					className="atlas-audio-bar"
					d={bar.d}
					key={bar.d}
					style={{ animationDelay: `${bar.delay}ms`, animationDuration: `${bar.duration}ms` }}
				/>
			))}
		</svg>
	);
}
