import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReasoningEffortControl } from "./reasoning-effort-control";
Object.assign(globalThis, { React });

const render = (props: Partial<React.ComponentProps<typeof ReasoningEffortControl>> = {}) =>
  renderToStaticMarkup(<ReasoningEffortControl choices={["off", "low", "medium", "high"]} onChange={() => {}} value={undefined} {...props} />);

test("mostra Raciocínio com Padrão do modelo e os quatro níveis, na ordem", () => {
  const html = render();
  assert.match(html, />Raciocínio</);
  const order = ["Padrão", "Desligado", "Baixo", "Médio", "Alto"].map((label) => html.indexOf(`>${label}<`));
  assert.ok(order.every((index) => index > 0), "todos os rótulos aparecem");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(html, /aria-label="Padrão do modelo"/);
});

test("só os níveis suportados: modelo que não desliga não mostra Desligado", () => {
  const html = render({ choices: ["low", "medium", "high"] });
  assert.doesNotMatch(html, />Desligado</);
  assert.match(html, />Baixo</);
});

test("o selecionado fica marcado (aria-pressed) e o Padrão é o neutro", () => {
  const picked = render({ value: "medium" });
  assert.equal((picked.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.match(picked, /aria-pressed="true"[^>]*>Médio</);
  const neutral = render({ value: undefined });
  assert.match(neutral, /aria-pressed="true"[^>]*aria-label="Padrão do modelo"|aria-label="Padrão do modelo"[^>]*aria-pressed="true"/);
});

test("usa tokens e primitivos do pacote ui (sem tamanho ou raio arbitrário)", () => {
  const html = render();
  assert.match(html, /data-slot="button-group"/);
  assert.doesNotMatch(html, /text-\[\d+px\]|rounded-\[\d+px\]/);
});

test("o ativo tem realce forte (bg-primary) e os demais não", () => {
  const html = render({ value: "low" });
  const buttons = html.match(/<button[^>]*>/g) ?? [];
  const active = buttons.filter((tag) => tag.includes('aria-pressed="true"'));
  assert.equal(active.length, 1);
  assert.match(active[0]!, /bg-primary/);
  const inactive = buttons.filter((tag) => tag.includes('aria-pressed="false"'));
  assert.ok(inactive.length >= 4);
  assert.ok(inactive.every((tag) => !/\bbg-primary\b/.test(tag)));
});
