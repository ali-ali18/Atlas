import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { PlanCard } from "./plan-card"

const STEPS = [
  { text: "Listar pedidos abertos", kind: "read" as const },
  { text: "Criar a proposta de cada pedido", kind: "write" as const },
  { text: "Confirmar a forma de pagamento", kind: "ask" as const },
]

describe("PlanCard", () => {
  it("pendente: passos numerados com ícone por tipo, 'Preciso de', riscos e as 3 ações", () => {
    const html = renderToStaticMarkup(
      <PlanCard
        needs={["Forma de pagamento", "Prazo de entrega"]}
        onAdjust={() => undefined}
        onApprove={() => undefined}
        onCancel={() => undefined}
        risks="A proposta criada não se desfaz"
        steps={STEPS}
        title="Criar propostas dos pedidos"
      />
    )
    expect(html).toContain("data-plan-card")
    expect(html).toContain('data-plan-status="pending"')
    expect(html).toContain("Criar propostas dos pedidos")
    expect(html).toContain("1.")
    expect(html).toContain("3.")
    for (const kind of ["read", "write", "ask"]) expect(html).toContain(`data-step-kind="${kind}"`)
    expect(html).toContain("Preciso de")
    expect(html).toContain("Forma de pagamento")
    expect(html).toContain("A proposta criada não se desfaz")
    expect(html).toContain("Aprovar plano")
    expect(html).toContain('aria-label="Ajustar"')
    expect(html).toContain('aria-label="Cancelar"')
    expect(html).toContain("max-md:hidden")
    expect(html).toContain("não aprova as ações")
  })

  it("celular: ajustar e cancelar viram botões só de ícone com o nome no aria-label (grupo de botões)", () => {
    const html = renderToStaticMarkup(<PlanCard onAdjust={() => undefined} steps={STEPS} title="Plano" />)
    expect(html).toContain('data-slot="button-group"')
    expect(html).toContain("max-md:w-8")
  })

  it("sem 'Preciso de' e sem riscos, as seções somem; sem onAdjust não há 'Ajustar'", () => {
    const html = renderToStaticMarkup(<PlanCard steps={STEPS} title="Plano" />)
    expect(html).not.toContain("data-plan-needs")
    expect(html).not.toContain("data-plan-risks")
    expect(html).not.toContain('aria-label="Ajustar"')
  })

  it("decidido: sem ações, com o selo do estado e o plano recolhido", () => {
    for (const [status, label] of [
      ["approved", "Plano aprovado"],
      ["adjusted", "Ajuste pedido"],
      ["cancelled", "Cancelado"],
    ] as const) {
      const html = renderToStaticMarkup(<PlanCard onApprove={() => undefined} status={status} steps={STEPS} title="Plano" />)
      expect(html).toContain(label)
      expect(html).toContain(`data-plan-status="${status}"`)
      expect(html).not.toContain("Aprovar plano")
      expect(html).not.toContain("data-slot=\"chat-card-actions\"")
      expect(html).toContain("Ver plano")
    }
  })
})
