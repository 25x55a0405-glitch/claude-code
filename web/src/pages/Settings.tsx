import { api, type AvatarCharacter, type AvatarColor, type Settings as S, type Tone } from '../api';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { PushSetup } from '../components/PushSetup';
import { PageHead, Segmented, Skeleton, Switch } from '../components/ui';
import { useAgent } from '../lib/agent';
import { useTheme, type ThemePref } from '../lib/theme';

const CHARACTERS: { value: AvatarCharacter; label: string }[] = [
  { value: 'cloud', label: 'Cloud' },
  { value: 'dot', label: 'Dot' },
  { value: 'drop', label: 'Drop' },
];
const COLORS: AvatarColor[] = ['sky', 'peach', 'mint', 'lilac', 'sun'];

export function Settings() {
  const { status, settings: d, setSettings } = useAgent();
  const [theme, setTheme] = useTheme();

  const save = async (patch: Partial<S>) => {
    if (d) setSettings({ ...d, ...patch });
    setSettings(await api.updateSettings(patch));
  };

  if (!d) return <div className="page"><Skeleton h={180} n={2} /></div>;

  return (
    <div className="page">
      <PageHead title={`Your ${d.agentName}`} sub="Your main Star. Give it a name and a look; your other Stars are in the constellation.">
        <a className="btn" href="#/stars"><Icon name="sparkle" size={15} /> Constellation</a>
      </PageHead>

      <section className="panel studio">
        <div className="studio-stage"><Avatar size={120} track state={status?.state ?? 'idle'} character={d.avatar.character} color={d.avatar.color} /></div>
        <div className="col-lg">
          <div>
            <label className="label" htmlFor="st-agent">Name</label>
            <input id="st-agent" className="field" defaultValue={d.agentName} onBlur={(e) => e.target.value.trim() && e.target.value !== d.agentName && save({ agentName: e.target.value.trim() })} />
          </div>
          <div>
            <span className="label">Character</span>
            <div className="pick">
              {CHARACTERS.map((c) => (
                <button key={c.value} aria-pressed={d.avatar.character === c.value} aria-label={c.label} title={c.label} onClick={() => save({ avatar: { ...d.avatar, character: c.value } })}>
                  <Avatar size={36} character={c.value} color={d.avatar.color} />
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="label">Colour</span>
            <div className="row" style={{ gap: 10 }}>
              {COLORS.map((c) => (
                <button key={c} className="swatch" data-av={c} aria-pressed={d.avatar.color === c} aria-label={c} onClick={() => save({ avatar: { ...d.avatar, color: c } })} />
              ))}
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="section-title">Personality</div>
        <div className="panel">
          <div className="rows">
            <div className="r between" style={{ flexWrap: 'wrap' }}>
              <div><h3>Tone</h3><p className="t3 xs">How {d.agentName} talks to you.</p></div>
              <Segmented<Tone> label="Tone" value={d.tone} onChange={(tone) => save({ tone })} options={[{ value: 'warm', label: 'Warm' }, { value: 'concise', label: 'Concise' }, { value: 'playful', label: 'Playful' }, { value: 'formal', label: 'Formal' }]} />
            </div>
            <div className="r between">
              <label htmlFor="st-name"><h3>What it calls you</h3></label>
              <input id="st-name" className="field" style={{ maxWidth: 180 }} defaultValue={d.userName} onBlur={(e) => e.target.value.trim() && e.target.value !== d.userName && save({ userName: e.target.value.trim() })} />
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="section-title">Rhythm</div>
        <div className="panel">
          <div className="rows">
            <div className="r between">
              <div className="grow"><h3>Morning briefing</h3><p className="t3 xs">A short message each morning with your day and what happened overnight.</p></div>
              {d.briefingTime !== null && <input type="time" id="st-brief" className="field" style={{ width: 116 }} value={d.briefingTime} onChange={(e) => save({ briefingTime: e.target.value })} aria-label="Briefing time" />}
              <Switch label="Morning briefing" checked={d.briefingTime !== null} onChange={(on) => save({ briefingTime: on ? '08:00' : null })} />
            </div>
            <div className="r between" style={{ flexWrap: 'wrap' }}>
              <div className="grow"><h3>Quiet hours</h3><p className="t3 xs">Holds anything that isn’t urgent.</p></div>
              {d.quietHours.enabled && (
                <div className="row">
                  <input type="time" id="st-q1" className="field" style={{ width: 112 }} value={d.quietHours.start} onChange={(e) => save({ quietHours: { ...d.quietHours, start: e.target.value } })} aria-label="Quiet hours start" />
                  <input type="time" id="st-q2" className="field" style={{ width: 112 }} value={d.quietHours.end} onChange={(e) => save({ quietHours: { ...d.quietHours, end: e.target.value } })} aria-label="Quiet hours end" />
                </div>
              )}
              <Switch label="Quiet hours" checked={d.quietHours.enabled} onChange={(enabled) => save({ quietHours: { ...d.quietHours, enabled } })} />
            </div>
            <div className="r between">
              <div className="grow"><h3>Look into things on its own</h3><p className="t3 xs">Read-only research between conversations, so it can bring you ideas.</p></div>
              <Switch label="Proactive research" checked={d.proactiveResearch} onChange={(proactiveResearch) => save({ proactiveResearch })} />
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="section-title">Where it reaches you</div>
        <div className="panel">
          <div className="rows">
            {([['web', 'Here in the app'], ['push', 'Push notifications'], ['email', 'Email'], ['slack', 'Slack'], ['telegram', 'Telegram']] as [keyof S['channels'], string][]).map(([k, label]) => (
              <div key={k} className="r between">
                <h3>{label}</h3>
                <Switch label={label} checked={d.channels[k]} disabled={k === 'web'} onChange={(v) => save({ channels: { ...d.channels, [k]: v } })} />
              </div>
            ))}
          </div>
        </div>
      </section>

      <PushSetup />

      <section>
        <div className="section-title">Appearance</div>
        <div className="panel">
          <div className="rows">
            <div className="r between">
              <h3>Theme</h3>
              <Segmented<ThemePref> label="Theme" value={theme} onChange={setTheme} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
            </div>
          </div>
        </div>
      </section>

      <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => api.setPaused(status?.state !== 'paused')}>
        <Icon name={status?.state === 'paused' ? 'play' : 'pause'} size={15} />
        {status?.state === 'paused' ? 'Wake every Star' : 'Pause every Star'}
      </button>
    </div>
  );
}
