import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CHAT_CARD_COPY, seeAllLabel } from "../lib/chat-card-copy"
import {
  ChatCard,
  ChatCardDetails,
  ChatCardError,
  ChatCardHeader,
  ChatCardLine,
} from "./chat-card"

describe("ChatCard", () => {
  it("variante card: pele única (rounded-2xl, sem borda, bg-muted/60, largura 68ch)", () => {
    const html = renderToStaticMarkup(
      <ChatCard>
        <ChatCardHeader badge={{ tone: "pending", label: CHAT_CARD_COPY.needsYou }} title="Enviar?" />
      </ChatCard>
    )
    expect(html).toContain('data-slot="chat-card"')
    expect(html).toContain("rounded-2xl")
    expect(html).toContain("bg-muted/60")
    expect(html).toContain("max-w-[min(68ch,100%)]")
    expect(html).not.toContain("border")
    expect(html).toContain("Precisa de você")
  })

  it("variante activity: linha compacta com ícone e texto", () => {
    const html = renderToStaticMarkup(
      <ChatCard variant="activity">
        <ChatCardLine leading={<i />}>Pesquisou na web</ChatCardLine>
      </ChatCard>
    )
    expect(html).toContain('data-variant="activity"')
    expect(html).toContain("Pesquisou na web")
    expect(html).toContain("bg-muted/60")
  })

  it("detalhes: fechado mostra 'Ver detalhes' sem o corpo; aberto mostra 'Mostrar menos'", () => {
    const closed = renderToStaticMarkup(<ChatCardDetails>corpo secreto</ChatCardDetails>)
    expect(closed).toContain("Ver detalhes")
    expect(closed).not.toContain("corpo secreto")
    const open = renderToStaticMarkup(<ChatCardDetails defaultOpen>corpo secreto</ChatCardDetails>)
    expect(open).toContain("Mostrar menos")
    expect(open).toContain("corpo secreto")
  })

  it("erro em caixa padrão com role alert", () => {
    const html = renderToStaticMarkup(<ChatCardError>Falhou</ChatCardError>)
    expect(html).toContain('role="alert"')
    expect(html).toContain("bg-destructive/10")
  })
})

describe("CHAT_CARD_COPY", () => {
  it("vocabulário único", () => {
    expect(CHAT_CARD_COPY).toEqual({
      details: "Ver detalhes",
      less: "Mostrar menos",
      seeAll: "Ver tudo",
      dismiss: "Agora não",
      dismissed: "Dispensado",
      needsYou: "Precisa de você",
      deny: "Recusar",
    })
    expect(seeAllLabel(5)).toBe("Ver tudo (5)")
  })
})
