import { api, type Settings as S, type Tone } from '../api';
import { Icon } from '../components/Icon';
import { ErrorNote, Orb, Segmented, Skeleton, Toggle, useToast } from '../components/ui';
import { useResource } from '../lib/hooks';
import { href } from '../lib/router';
import { useStatus } from '../lib/status';
import { useTheme, type ThemePref } from '../lib/theme';

export function Settings() {
  const toast = useToast();
  const status = useStatus();
  const [theme, setTheme] = useTheme();
  const s = useResource(() => api.getSettings(), []);

  const save = async (patch: Partial<S>) => {
    s.setData((cur) => cur && { ...cur, ...patch });
    s.setData(await api.updateSettings(patch));
  };

  if (s.error) return <div className="page"><ErrorNote error={s.error} retry={s.reload} /></div>;
  const d = s.data;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">Make Skys yours.</p>
        </div>
      </div>

      <section className="card row-between">
        <div className="row">
          <Orb state={status?.state ?? 'idle'} size="md" />
          <div>
            <h2>{status?.state === 'paused' ? 'Skys is paused' : 'Skys is on'}</h2>
            <p className="faint">{status?.state === 'paused' ? 'No background work or actions until you resume.' : 'Working in the background, even when this tab is closed.'}</p>
          </div>
        </div>
        <button
          className={`btn ${status?.state === 'paused' ? 'btn-primary' : ''}`}
          onClick={async () => {
            const paused = status?.state !== 'paused';
            await api.setPaused(paused);
            toast(paused ? 'Skys paused' : 'Skys resumed');
          }}
        >
          <Icon name={status?.state === 'paused' ? 'play' : 'pause'} size={16} />
          {status?.state === 'paused' ? 'Resume' : 'Pause everything'}
        </button>
      </section>

      {!d ? (
        <Skeleton h={200} n={2} />
      ) : (
        <div className="grid-2">
          <section className="card">
            <div className="card-head"><h2>Personality</h2></div>
            <div className="stack-lg">
              <div>
                <label className="lbl" htmlFor="st-name">What should Skys call you?</label>
                <input id="st-name" className="field" defaultValue={d.userName} onBlur={(e) => e.target.value !== d.userName && save({ userName: e.target.value })} />
              </div>
              <div>
                <label className="lbl" htmlFor="st-agent">Agent name</label>
                <input id="st-agent" className="field" defaultValue={d.agentName} onBlur={(e) => e.target.value !== d.agentName && save({ agentName: e.target.value })} />
              </div>
              <div>
                <span className="lbl">Tone</span>
                <Segmented<Tone>
                  label="Tone"
                  value={d.tone}
                  onChange={(tone) => save({ tone })}
                  options={[{ value: 'warm', label: 'Warm' }, { value: 'concise', label: 'Concise' }, { value: 'playful', label: 'Playful' }, { value: 'formal', label: 'Formal' }]}
                />
              </div>
              <div>
                <span className="lbl">Appearance</span>
                <Segmented<ThemePref>
                  label="Appearance"
                  value={theme}
                  onChange={setTheme}
                  options={[{ value: 'system', label: 'System' }, { value: 'dark', label: 'Night' }, { value: 'light', label: 'Day' }]}
                />
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head"><h2>Rhythm</h2></div>
            <div className="setting">
              <div className="txt">
                <h3>Daily briefing</h3>
                <p className="faint">A summary of your day and what Skys did overnight.</p>
              </div>
              <div className="row">
                {d.briefingTime !== null && (
                  <input type="time" className="field" style={{ width: 120 }} value={d.briefingTime} onChange={(e) => save({ briefingTime: e.target.value })} aria-label="Briefing time" />
                )}
                <Toggle label="Daily briefing" checked={d.briefingTime !== null} onChange={(on) => save({ briefingTime: on ? '08:00' : null })} />
              </div>
            </div>
            <div className="setting">
              <div className="txt">
                <h3>Quiet hours</h3>
                <p className="faint">Hold non-urgent notifications.</p>
              </div>
              <div className="row">
                {d.quietHours.enabled && (
                  <>
                    <input type="time" className="field" style={{ width: 110 }} value={d.quietHours.start} onChange={(e) => save({ quietHours: { ...d.quietHours, start: e.target.value } })} aria-label="Quiet hours start" />
                    <input type="time" className="field" style={{ width: 110 }} value={d.quietHours.end} onChange={(e) => save({ quietHours: { ...d.quietHours, end: e.target.value } })} aria-label="Quiet hours end" />
                  </>
                )}
                <Toggle label="Quiet hours" checked={d.quietHours.enabled} onChange={(enabled) => save({ quietHours: { ...d.quietHours, enabled } })} />
              </div>
            </div>
            <div className="setting">
              <div className="txt">
                <h3>Proactive research</h3>
                <p className="faint">Let Skys look into things on its own using read-only access.</p>
              </div>
              <Toggle label="Proactive research" checked={d.proactiveResearch} onChange={(proactiveResearch) => save({ proactiveResearch })} />
            </div>
            <div className="setting">
              <div className="txt">
                <h3>Time zone</h3>
                <p className="faint">{d.timezone}</p>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head"><h2>Where Skys reaches you</h2></div>
            {(
              [
                ['web', 'This app'],
                ['push', 'Push notifications'],
                ['email', 'Email'],
                ['slack', 'Slack'],
                ['telegram', 'Telegram'],
              ] as [keyof S['channels'], string][]
            ).map(([k, label]) => (
              <div key={k} className="setting">
                <h3>{label}</h3>
                <Toggle label={label} checked={d.channels[k]} disabled={k === 'web'} onChange={(v) => save({ channels: { ...d.channels, [k]: v } })} />
              </div>
            ))}
          </section>

          <section className="card stack">
            <div className="card-head"><h2>More</h2></div>
            <a className="row" href={href('rules')}><Icon name="rules" /> Rules and autonomy <span className="spacer" /><Icon name="chevron" /></a>
            <a className="row" href={href('connections')}><Icon name="plug" /> Connections <span className="spacer" /><Icon name="chevron" /></a>
            <a className="row" href={href('memory')}><Icon name="brain" /> Memory <span className="spacer" /><Icon name="chevron" /></a>
            <a className="row" href={href('activity')}><Icon name="activity" /> Activity log <span className="spacer" /><Icon name="chevron" /></a>
          </section>
        </div>
      )}
    </div>
  );
}
