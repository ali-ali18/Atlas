import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { getModelCapabilities, roleCapabilityWarning } from "@workspace/shared"
import { ModelCapabilityBadges, ModelCapabilityWarning } from "./model-capability-badges"

describe("ModelCapabilityBadges", () => {
  it("mostra só o que o modelo tem", () => {
    const html = renderToStaticMarkup(
      <ModelCapabilityBadges capabilities={{ ...getModelCapabilities("anthropic/claude-sonnet-5"), contextTokens: 200_000 }} />
    )
    for (const label of ["Imagem", "PDF", "Ferramentas", "200k"]) expect(html).toContain(label)
    const text = renderToStaticMarkup(
      <ModelCapabilityBadges capabilities={{ vision: false, pdf: false, tools: true, contextTokens: null }} />
    )
    expect(text).toContain("Ferramentas")
    expect(text).not.toMatch(/Imagem|PDF|k</)
  })
  it("não renderiza nada sem capacidade conhecida", () => {
    expect(renderToStaticMarkup(<ModelCapabilityBadges capabilities={{ vision: false, pdf: false, tools: false, contextTokens: null }} />)).toBe("")
  })
})

describe("ModelCapabilityWarning", () => {
  it("avisa modelo de leitura de imagem sem visão e some quando atende", () => {
    const warn = roleCapabilityWarning("vision", getModelCapabilities("openai/gpt-3.5-turbo"))
    expect(renderToStaticMarkup(<ModelCapabilityWarning message={warn} />)).toContain("não lê imagens")
    expect(renderToStaticMarkup(<ModelCapabilityWarning message={roleCapabilityWarning("vision", getModelCapabilities("openai/gpt-5"))} />)).toBe("")
  })
})
