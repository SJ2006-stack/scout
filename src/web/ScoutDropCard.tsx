import { useEffect, useState } from "react";
import { Link2, X } from "lucide-react";
import { dropDraft, dropMessage, linkLabel, type DropImage, type SharedDrop } from "../shared/scoutDrop.ts";
import { readAttachment } from "./ocr.ts";
import { finishSharedDrop, sharedImageFile } from "./scoutDrop.ts";
import "./scoutDrop.css";

type Picture = { image: DropImage; file: File; preview: string };

type ScoutDropCardProps = {
  drop: SharedDrop;
  busy: boolean;
  onSend: (message: string) => void;
  onClose: () => void;
  onToast: (message: string) => void;
};

/** Review step for something shared from another app. Nothing leaves the phone until Send. */
export function ScoutDropCard({ drop, busy, onSend, onClose, onToast }: ScoutDropCardProps) {
  const [draft, setDraft] = useState(() => dropDraft(drop));
  const [pictures, setPictures] = useState<Picture[]>([]);
  const [missing, setMissing] = useState(0);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const loaded: Picture[] = [];
    let failed = 0;
    for (const image of drop.images) {
      const file = sharedImageFile(drop, image);
      if (file) loaded.push({ image, file, preview: URL.createObjectURL(file) });
      else failed += 1;
    }
    setPictures(loaded);
    setMissing(failed);
    return () => loaded.forEach((picture) => URL.revokeObjectURL(picture.preview));
  }, [drop]);

  function remove(id: string): void {
    setPictures((current) => current.filter((picture) => picture.image.id !== id));
  }

  function dismiss(): void {
    finishSharedDrop(drop);
    onClose();
  }

  async function send(): Promise<void> {
    if (busy || sending) return;
    setSending(true);
    const reads: string[] = [];
    let unread = 0;
    for (const picture of pictures) {
      try {
        reads.push(await readAttachment(picture.file));
      } catch {
        unread += 1;
      }
    }
    setSending(false);
    const message = dropMessage(draft, reads);
    if (message.length === 0) {
      onToast(unread > 0 ? "Scout could not read the shared image. Add a note and send again." : "Add a note before sending.");
      return;
    }
    if (unread > 0) onToast(unread === 1 ? "One image could not be read, so it was left out." : `${unread} images could not be read, so they were left out.`);
    onSend(message);
    finishSharedDrop(drop);
    onClose();
  }

  const notes = missing > 0 ? [...drop.notes, `${missing === 1 ? "1 image" : `${missing} images`} could not be loaded.`] : drop.notes;
  const empty = draft.trim().length === 0 && pictures.length === 0;

  return (
    <section className="drop-card" aria-label="Shared to Scout">
      <header className="drop-head">
        <strong>Shared to Scout</strong>
        <span className="muted">Review it, then send. Nothing is sent yet.</span>
      </header>
      <textarea
        className="drop-text"
        value={draft}
        rows={3}
        aria-label="Shared text"
        placeholder="Add a note for Scout"
        onChange={(event) => setDraft(event.target.value)}
      />
      {drop.urls.length > 0 ? (
        <ul className="drop-links">
          {drop.urls.map((url) => (
            <li key={url} title={url}>
              <Link2 size={14} aria-hidden="true" />
              <span>{linkLabel(url)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {pictures.length > 0 ? (
        <ul className="drop-images">
          {pictures.map((picture) => (
            <li key={picture.image.id}>
              <img src={picture.preview} alt="Shared image" />
              <button type="button" className="drop-remove" aria-label="Remove image" disabled={sending} onClick={() => remove(picture.image.id)}>
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {notes.length > 0 ? (
        <ul className="drop-notes">
          {notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      ) : null}
      <div className="drop-actions">
        <button type="button" className="text-button" disabled={sending} onClick={dismiss}>Discard</button>
        <button type="button" className="drop-send" disabled={busy || sending || empty} onClick={() => void send()}>
          {sending ? "Reading images…" : pictures.length > 0 ? "Read and send" : "Send to Scout"}
        </button>
      </div>
    </section>
  );
}
