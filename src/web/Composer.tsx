import type { KeyboardEvent } from "react";
import { ArrowUp, Mic, Plus, Square } from "lucide-react";

type ComposerProps = {
  value: string;
  busy: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onToast: (message: string) => void;
};

export function Composer({ value, busy, placeholder, onChange, onSend, onStop, onToast }: ComposerProps) {
  const empty = value.trim().length === 0;

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (!busy && !empty) onSend();
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && !empty) onSend();
      }}
    >
      <button className="icon-button composer-plus" type="button" aria-label="Add attachment" title="Add attachment" onClick={() => onToast("Attachments coming soon.")}>
        <Plus size={20} />
      </button>
      <div className="composer-field">
        <textarea
          name="message"
          rows={1}
          value={value}
          placeholder={placeholder}
          aria-label="Message"
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className="icon-button mic" type="button" aria-label="Voice input" title="Voice input" onClick={() => onToast("Voice input coming soon.")}>
          <Mic size={18} />
        </button>
        {busy ? (
          <button className="send" type="button" aria-label="Stop" onClick={onStop}>
            <Square size={16} />
          </button>
        ) : (
          <button className="send" type="submit" aria-label="Send" disabled={empty}>
            <ArrowUp size={18} />
          </button>
        )}
      </div>
    </form>
  );
}
