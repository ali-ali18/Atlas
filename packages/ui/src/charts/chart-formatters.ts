import { createContext } from "react";

// Adaptado do Bklit UI (MIT): formatadores em pt-BR em vez de en-US.
export const shortDateFmt = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
});

export const weekdayDateFmt = new Intl.DateTimeFormat("pt-BR", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
});

export const hmsTimeFmt = new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

// `Intl.NumberFormat.prototype.format` is a bound getter — safe to extract.
export const intFmt = new Intl.NumberFormat("pt-BR").format;

/**
 * Formatador do rótulo do eixo X (linha/área) vindo de fora: gráficos de categorias usam datas sintéticas
 * (um dia por ponto) e este contexto devolve o nome da categoria no lugar de "dd/mm".
 */
export const XLabelFormatContext = createContext<((date: Date) => string) | null>(null);
