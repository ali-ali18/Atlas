// Estado dos anexos do composer: escolhe, valida, sobe ao escolher (cancelável) e entrega os prontos no envio.
import * as React from "react";
import { canSendAttachments, countsOf, fileSlotsLeft, imageSlotsLeft, isUploading, patchDraft, removeDraft, toOutgoing, uploadErrorMessage, validatePicked, type AttachmentDraft, type OutgoingAttachment, type PickedFile } from "./attachments";
import type { ApiFetch } from "./home-sync";
import { UploadError, uploadAttachment } from "./upload-api";

export type AttachmentsApi = {
	drafts: readonly AttachmentDraft[];
	/** Aviso curto sobre o último item recusado antes de subir (limite, formato). */
	notice: string | null;
	uploading: boolean;
	/** Nada subindo e nada com erro: pode enviar. */
	ready: boolean;
	imageSlots: number;
	fileSlots: number;
	add: (picked: readonly PickedFile[]) => void;
	remove: (key: string) => void;
	/** Esvazia a lista depois do envio (sem cancelar nada: só há anexos prontos). */
	clear: () => void;
	/** Anexos prontos para o envio, na ordem. */
	outgoing: () => OutgoingAttachment[];
	dismissNotice: () => void;
};

let nextKey = 0;

export function useAttachments(apiFetch: ApiFetch): AttachmentsApi {
	const [drafts, setDrafts] = React.useState<AttachmentDraft[]>([]);
	const [notice, setNotice] = React.useState<string | null>(null);
	// Espelho síncrono: vários itens escolhidos de uma vez precisam contar os limites uns dos outros.
	const latest = React.useRef<AttachmentDraft[]>([]);
	const aborts = React.useRef(new Map<string, AbortController>());
	const apply = React.useCallback((next: AttachmentDraft[]) => {
		latest.current = next;
		setDrafts(next);
	}, []);

	React.useEffect(() => {
		const map = aborts.current;
		return () => {
			for (const controller of map.values()) controller.abort();
			map.clear();
		};
	}, []);

	const upload = React.useCallback(
		async (draft: AttachmentDraft) => {
			const controller = new AbortController();
			aborts.current.set(draft.key, controller);
			try {
				const result = await uploadAttachment(apiFetch, draft.route, { uri: draft.uri, name: draft.name, mime: draft.mime }, controller.signal);
				if (controller.signal.aborted) return;
				apply(patchDraft(latest.current, draft.key, { status: "done", artifactId: result.id, ...(result.width && !draft.width ? { width: result.width } : {}), ...(result.height && !draft.height ? { height: result.height } : {}) }));
			} catch (reason) {
				if (controller.signal.aborted) return;
				apply(patchDraft(latest.current, draft.key, { status: "error", error: uploadErrorMessage(reason instanceof UploadError ? reason.status : null, draft.route) }));
			} finally {
				aborts.current.delete(draft.key);
			}
		},
		[apiFetch, apply],
	);

	const add = React.useCallback(
		(picked: readonly PickedFile[]) => {
			let notice: string | null = null;
			for (const item of picked) {
				const verdict = validatePicked(item, countsOf(latest.current));
				if (!verdict.ok) {
					notice = verdict.message;
					continue;
				}
				nextKey += 1;
				const draft: AttachmentDraft = {
					key: `att-${Date.now()}-${nextKey}`,
					route: verdict.route,
					uri: item.uri,
					name: verdict.name,
					mime: verdict.mime,
					status: "uploading",
					...(typeof item.size === "number" ? { size: item.size } : {}),
					...(item.width ? { width: item.width } : {}),
					...(item.height ? { height: item.height } : {}),
				};
				apply([...latest.current, draft]);
				void upload(draft);
			}
			setNotice(notice);
		},
		[apply, upload],
	);

	const remove = React.useCallback(
		(key: string) => {
			aborts.current.get(key)?.abort();
			aborts.current.delete(key);
			apply(removeDraft(latest.current, key));
		},
		[apply],
	);

	const clear = React.useCallback(() => {
		apply([]);
		setNotice(null);
	}, [apply]);

	const counts = countsOf(drafts);
	return {
		drafts,
		notice,
		uploading: isUploading(drafts),
		ready: canSendAttachments(drafts),
		imageSlots: imageSlotsLeft(counts),
		fileSlots: fileSlotsLeft(counts),
		add,
		remove,
		clear,
		outgoing: () => toOutgoing(latest.current),
		dismissNotice: () => setNotice(null),
	};
}
