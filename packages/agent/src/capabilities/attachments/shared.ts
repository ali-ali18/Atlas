// Peças comuns das tools de anexo: o id (formato fixo, validado) e a mensagem de "não achei" (igual para inexistente e de outro dono).
import { z } from "zod";

export const ATTACHMENT_NOT_FOUND = "Attachment not found in this conversation. Use an id from attachment_list (or from an attachment line in the chat).";

export const idField = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be an attachment id (letters, digits, - or _)").describe("Attachment id.");
