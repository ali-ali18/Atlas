import { describe, expect, it } from "vitest";

import { cn } from "./utils";

describe("cn com tokens do tema", () => {
  it("text-body e text-caption são tamanho, não cor: não apagam a cor vizinha", () => {
    expect(cn("text-muted-foreground", "text-body")).toBe("text-muted-foreground text-body");
    expect(cn("text-body", "text-success")).toBe("text-body text-success");
    expect(cn("text-caption", "text-warning/80")).toBe("text-caption text-warning/80");
  });

  it("o último tamanho vence", () => {
    expect(cn("text-sm", "text-body")).toBe("text-body");
    expect(cn("text-body", "text-caption")).toBe("text-caption");
  });

  it("raios semânticos conflitam com a escala de raios", () => {
    expect(cn("rounded-xl", "rounded-card")).toBe("rounded-card");
    expect(cn("rounded-panel", "rounded-lg")).toBe("rounded-lg");
  });

  it("cores de status coexistem com fundo e borda", () => {
    expect(cn("bg-success/10", "text-success", "border-success/40")).toBe("bg-success/10 text-success border-success/40");
  });
});
