import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

export function Composer({ onSend, placeholder, autoFocus }: { onSend: (text: string) => void; placeholder: string; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
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
      <button className="send" type="submit" disabled={!text.trim()} aria-label="Send"><Icon name="up" size={18} /></button>
    </form>
  );
}
