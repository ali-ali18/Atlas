// Gera o logo "só o avatar" (fundo transparente, ~12% de respiro) usado como
// `logo_uri` no registro OAuth de clientes MCP. Fonte: apps/web/public/icons/avatar.svg.
// Uso: node scripts/generate-logo-avatar.mjs
import { readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(new URL("../packages/agent-runtime/package.json", import.meta.url))
const sharp = require("sharp")

const dir = fileURLToPath(new URL("../apps/web/public/icons/", import.meta.url))
const source = readFileSync(`${dir}avatar.svg`, "utf8")

// Caixa do corpo do avatar (já com o translate do grupo): ~181 x 166, centro (130.6, 125.05).
// Quadrado de lado 238 => ~12% de margem em cada lado do eixo maior.
const SIDE = 238
const [cx, cy] = [130.6, 125.05]
const svg = source.replace(
  /<svg [^>]*>/,
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIDE}" height="${SIDE}" viewBox="${cx - SIDE / 2} ${cy - SIDE / 2} ${SIDE} ${SIDE}">`,
)
writeFileSync(`${dir}logo-avatar.svg`, svg)

for (const size of [256, 512]) {
  const file = size === 512 ? "logo-avatar.png" : `logo-avatar-${size}.png`
  await sharp(Buffer.from(svg), { density: (72 * size) / SIDE })
    .resize(size, size)
    .png()
    .toFile(`${dir}${file}`)
}
