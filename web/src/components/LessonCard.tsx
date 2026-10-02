import { useState } from 'react';
import { api, type Lesson } from '../api';
import { href } from '../lib/router';
import { Icon } from './Icon';
import { Rich } from './StarNote';
import { useToast } from './ui';

/** "Got it. I'll remember: …" with a way to take it back. */
export function LessonCard({ text, lesson, onUndone }: { text: string; lesson?: Lesson; onUndone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [undone, setUndone] = useState(false);
  const gone = undone || lesson?.undone;

  const undo = async () => {
    if (!lesson) return;
    setBusy(true);
    try {
      await api.undoLesson(lesson.id);
      setUndone(true);
      onUndone();
      toast('Forgotten');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`lesson-card ${gone ? 'gone' : ''}`}>
      <span className="ico"><Icon name="brain" size={16} /></span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="txt"><Rich text={text} /></div>
        <div className="meta">
          {gone ? 'Forgotten. It won’t use this.' : lesson?.skillId ? <>Added to a <a href={href('skills')}>skill</a></> : <>Saved to <a href={href('memory')}>memory</a></>}
        </div>
      </div>
      {lesson && !gone && <button className="btn sm quiet" onClick={undo} disabled={busy}>{busy ? 'Undoing…' : 'Undo'}</button>}
    </div>
  );
}
