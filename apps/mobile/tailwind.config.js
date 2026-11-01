const { hairlineWidth } = require("nativewind/theme");

// Mesmos nomes de token do packages/ui. Cada variável guarda os canais "r g b" (ver lib/theme.ts),
// o que permite o modificador de opacidade igual ao web: `bg-muted/60`, `text-success/70`.
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
	darkMode: "class",
	content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
	presets: [require("nativewind/preset")],
	theme: {
		extend: {
			colors: {
				background: token("background"),
				foreground: token("foreground"),
				card: { DEFAULT: token("card"), foreground: token("card-foreground") },
				popover: { DEFAULT: token("popover"), foreground: token("popover-foreground") },
				primary: { DEFAULT: token("primary"), foreground: token("primary-foreground") },
				secondary: { DEFAULT: token("secondary"), foreground: token("secondary-foreground") },
				muted: { DEFAULT: token("muted"), foreground: token("muted-foreground") },
				accent: { DEFAULT: token("accent"), foreground: token("accent-foreground") },
				destructive: token("destructive"),
				success: { DEFAULT: token("success"), foreground: token("success-foreground") },
				warning: { DEFAULT: token("warning"), foreground: token("warning-foreground") },
				info: { DEFAULT: token("info"), foreground: token("info-foreground") },
				border: token("border"),
				input: token("input"),
				ring: token("ring"),
			},
			// Tokens semânticos do globals.css do web (text-body 13px, text-caption 11px, raios card/panel).
			// `control` (17px) é só do mobile: texto de botão e campo, no tamanho do app do celular.
			fontSize: { body: ["13px", { lineHeight: "18px" }], caption: ["11px", { lineHeight: "15px" }], control: ["17px", { lineHeight: "22px" }] },
			borderRadius: { card: "12px", panel: "20px", "4xl": "2rem" },
			borderWidth: { hairline: hairlineWidth() },
		},
	},
	plugins: [],
};
