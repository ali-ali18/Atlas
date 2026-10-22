import nodemailer from "nodemailer";
import { describe, expect, it } from "vitest";

// Usa o nodemailer real (sem mock) para garantir que a API usada em
// `sendMail` continua válida depois de atualizações de major.
describe("nodemailer (API real)", () => {
  it("cria transporte a partir de URL smtps:// sem abrir conexão", () => {
    const transport = nodemailer.createTransport("smtps://person%40example.com:secret@smtp.example.com:465");
    expect(typeof transport.sendMail).toBe("function");
    transport.close();
  });

  it("monta a mensagem com remetente, destinatário, html e texto", async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const info = await transport.sendMail({
      from: "Atlas <atlas@example.com>",
      to: "person@example.com",
      subject: "Sign in",
      html: '<a href="https://example.com/sign-in">Sign in</a>',
      text: "https://example.com/sign-in",
    });
    const sent = JSON.parse(String(info.message));
    expect(sent.from).toEqual({ address: "atlas@example.com", name: "Atlas" });
    expect(sent.to).toEqual([{ address: "person@example.com", name: "" }]);
    expect(sent.subject).toBe("Sign in");
    expect(sent.html).toContain("https://example.com/sign-in");
    expect(sent.text).toBe("https://example.com/sign-in");
  });
});
