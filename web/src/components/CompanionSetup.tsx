import { useEffect, useState } from 'react';
import { api, type CompanionDevice, type CompanionPairing } from '../api';
import { useAgent } from '../lib/agent';
import { relTime } from '../lib/format';
import { useLiveEvents, useResource } from '../lib/hooks';
import { Icon } from './Icon';
import { StarFace, Switch, useToast } from './ui';

const PLATFORM: Record<string, string> = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' };

/**
 * Your own computer, through the Sky companion. It dials out to Sky, so the
 * computer needs no open port. What it may touch is set on the computer itself;
 * here you switch it on or off, choose which Stars can use it, and unpair.
 */
export function CompanionSetup() {
  const toast = useToast();
  const { stars, reloadStars } = useAgent();
  const list = useResource(() => api.listCompanion(), []);
  const conns = useResource(() => api.listConnections(), []);
  const [pairing, setPairing] = useState<CompanionPairing | null>(null);
  const [busy, setBusy] = useState(false);

  useLiveEvents((e) => {
    if (e.type === 'companion.updated') {
      const fresh = !list.data?.devices.some((x) => x.id === e.data.id);
      if (fresh && pairing) { setPairing(null); toast(`${e.data.name} is paired`); }
      list.setData((d) => d && { ...d, devices: d.devices.some((x) => x.id === e.data.id) ? d.devices.map((x) => (x.id === e.data.id ? e.data : x)) : [...d.devices, e.data] });
    }
    if (e.type === 'companion.deleted') list.setData((d) => d && { ...d, devices: d.devices.filter((x) => x.id !== e.data.id) });
  });

  if (list.error || !list.data) return null;
  const devices = list.data.devices;

  const pair = async () => {
    setBusy(true);
    try { setPairing(await api.pairCompanion()); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const replace = (d: CompanionDevice) => list.setData((x) => x && { ...x, devices: x.devices.map((y) => (y.id === d.id ? d : y)) });

  // Which Stars can use it is the "Your computer" app in each Star's apps.
  const allIds = conns.data?.map((c) => c.id) ?? [];
  const canUse = (ids: string[] | null) => ids === null || ids.includes('computer');
  const toggleStar = async (id: string) => {
    const s = stars?.find((x) => x.id === id);
    if (!s || !conns.data) return;
    const ids = s.connectionIds;
    const next = canUse(ids) ? (ids ?? allIds).filter((x) => x !== 'computer') : [...(ids ?? []), 'computer'];
    try { await api.updateStar(s.id, { connectionIds: next }); reloadStars(); } catch (e) { toast((e as Error).message); }
  };

  return (
    <section>
      <div className="section-title">Your computer</div>
      <p className="t3" style={{ marginBottom: 12 }}>Let Stars open pages, read and write files, and run programs on your own computer, through the small Sky companion. Every action asks you here first, and on the computer too unless you turn that off there.</p>
      <div className="col">
        {devices.map((d) => <DeviceCard key={d.id} d={d} onChange={replace} onGone={() => list.setData((x) => x && { ...x, devices: x.devices.filter((y) => y.id !== d.id) })} />)}

        {pairing ? (
          <PairPanel pairing={pairing} download={list.data.download} onNew={pair} onCancel={() => setPairing(null)} />
        ) : (
          <div className="panel pad between" style={{ gap: 14 }}>
            <p className="t3">{devices.length ? 'Add another computer.' : 'Nothing paired yet. It takes a minute: run one command on the computer.'}</p>
            <button className="btn sm" onClick={pair} disabled={busy}><Icon name="laptop" size={14} /> {busy ? 'Making a code…' : 'Pair a computer'}</button>
          </div>
        )}

        {devices.length > 0 && stars && stars.length > 0 && conns.data && (
          <div className="panel pad col">
            <h3>Which Stars can use it</h3>
            <div className="who-filter" role="group" aria-label="Which Stars can use your computer">
              {stars.map((s) => <button key={s.id} aria-pressed={canUse(s.connectionIds)} onClick={() => toggleStar(s.id)}><StarFace star={s} size={20} still />{s.name}</button>)}
            </div>
            <p className="t3 xs">The same as turning on “Your computer” in a Star’s apps.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function DeviceCard({ d, onChange, onGone }: { d: CompanionDevice; onChange: (d: CompanionDevice) => void; onGone: () => void }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const live = d.connected && d.enabled && d.localEnabled;

  return (
    <div className="panel pad col device-card">
      <div className="row" style={{ gap: 12 }}>
        <span className="glyph"><Icon name="laptop" size={17} /></span>
        <div className="grow" style={{ minWidth: 0 }}>
          <h3>{d.name}</h3>
          <p className="t3 xs">{PLATFORM[d.platform] ?? d.platform} · {d.connected ? 'connected' : d.lastSeenAt ? `last seen ${relTime(d.lastSeenAt)}` : 'not connected yet'} · paired {relTime(d.pairedAt)}</p>
        </div>
        {live ? <span className="chip ok"><span className="dot" />On</span> : !d.enabled ? <span className="chip">Off here</span> : !d.localEnabled ? <span className="chip warn">Off on the computer</span> : <span className="chip">Not connected</span>}
        <Switch label={`Let Stars use ${d.name}`} checked={d.enabled} onChange={async (enabled) => { try { onChange(await api.updateCompanionDevice(d.id, { enabled })); toast(enabled ? `${d.name} on` : `${d.name} off. Nothing runs there now.`); } catch (e) { toast((e as Error).message); } }} />
      </div>

      <div className="allow">
        <div><span className="k">Folders</span><span className="v">{d.allow.folders.length ? d.allow.folders.map((f) => <code key={f} className="mono">{f}</code>) : <span className="t3">None yet</span>}</span></div>
        <div><span className="k">Programs</span><span className="v">{d.allow.commands.length ? d.allow.commands.map((c) => <code key={c} className="mono">{c}</code>) : <span className="t3">None yet</span>}</span></div>
        <div><span className="k">Web pages</span><span className="v">{d.allow.openUrls ? 'Can open them' : <span className="t3">Can’t open them</span>}</span></div>
        <div><span className="k">On the computer</span><span className="v">{d.confirmLocally ? 'Asks there too before each action' : <span className="t3">Doesn’t ask there (only here)</span>}</span></div>
      </div>
      <p className="t3 xs">Change it on the computer: <code className="mono">node sky-companion.mjs allow-folder &lt;path&gt;</code>. Sky can’t widen it from here. {!d.localEnabled && 'It’s switched off on the computer; press o in the companion to switch it on.'}</p>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
        {confirm ? (
          <>
            <span className="t3 xs grow">The companion forgets its key, and you’d pair again to use it.</span>
            <button className="btn sm quiet" onClick={() => setConfirm(false)}>Keep</button>
            <button className="btn sm danger" onClick={async () => { try { await api.deleteCompanionDevice(d.id); onGone(); toast(`${d.name} unpaired`); } catch (e) { toast((e as Error).message); } }}>Unpair</button>
          </>
        ) : <button className="btn sm quiet" onClick={() => setConfirm(true)}>Unpair</button>}
      </div>
    </div>
  );
}

function PairPanel({ pairing, download, onNew, onCancel }: { pairing: CompanionPairing; download: string; onNew: () => void; onCancel: () => void }) {
  const toast = useToast();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 10_000); return () => window.clearInterval(t); }, []);
  const left = Math.ceil((new Date(pairing.expiresAt).getTime() - now) / 60_000);
  const copy = async () => { try { await navigator.clipboard.writeText(pairing.command); toast('Command copied'); } catch { toast('Couldn’t copy. Select it and copy instead.'); } };

  return (
    <div className="panel pad col pair-panel">
      <div className="between">
        <h3>Pair a computer</h3>
        <button className="icon-btn" onClick={onCancel} aria-label="Cancel pairing"><Icon name="x" /></button>
      </div>
      <ol className="how">
        <li>On that computer, get <code className="mono">{download.split('/').pop()}</code> from the Sky repository (<code className="mono">{download}</code>). It needs Node 22 and nothing else.</li>
        <li>Run this there, in the same folder:</li>
      </ol>
      <div className="copy-row">
        <code className="mono">{pairing.command}</code>
        <button className="btn sm" onClick={copy}>Copy</button>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <span className="live-dot" />
        <p className="t2 grow" style={{ fontSize: 14 }}>Waiting for it to connect. This updates by itself.</p>
      </div>
      <p className="t3 xs">{left > 0 ? `The code works once, for ${left} more minute${left === 1 ? '' : 's'}.` : 'The code ran out.'} <button className="link-btn" onClick={onNew}>Make a new code</button></p>
    </div>
  );
}
