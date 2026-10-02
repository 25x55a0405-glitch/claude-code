import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

/**
 * onSend may reject; the text is then put back so nothing typed is lost.
 * Pass value and onChange to keep the draft outside, so it survives the box
 * being swapped for another one (the chat does this when it turns out empty).
 */
export function Composer({ onSend, placeholder, autoFocus, value, onChange, onVoice }: {
  onSend: (text: string) => void | Promise<void>;
  placeholder: string;
  autoFocus?: boolean;
  value?: string;
  onChange?: (text: string) => void;
  /** Shows a mic in place of send while the box is empty. */
  onVoice?: () => void;
}) {
  const [own, setOwn] = useState('');
  const text = value ?? own;
  const setText = (next: string | ((cur: string) => string)) => {
    const v = typeof next === 'function' ? next(text) : next;
    if (onChange) onChange(v);
    else setOwn(v);
  };
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  // A box that takes over a draft picks up where the typing was.
  useEffect(() => {
    const el = ref.current;
    if (!el || !el.value) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    Promise.resolve(onSend(t)).catch(() => (onChange ? onChange(t) : setOwn((cur) => cur || t)));
  };

  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
      <textarea
        id="composer"
        ref={ref}
        rows={1}
        value={text}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      {onVoice && !text.trim()
        ? <button className="send voice" type="button" onClick={onVoice} aria-label="Talk out loud" title="Talk out loud"><Icon name="mic" size={18} /></button>
        : <button className="send" type="submit" disabled={!text.trim()} aria-label="Send"><Icon name="up" size={18} /></button>}
    </form>
  );
}
