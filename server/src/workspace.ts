import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import type { WorkspaceFile, WorkspaceStatus } from './types.ts';
import { ApiError, badRequest, iso, notFound } from './util.ts';

/** Largest file a Star or the person can write in one go. */
/** What the sandbox gets of /etc: libraries, certificates, name lookup, users (names only, no passwords), time zone. */
const ETC_ALLOWED = ['ld.so.cache', 'ld.so.conf', 'ld.so.conf.d', 'ssl', 'ca-certificates', 'alternatives', 'resolv.conf', 'hosts', 'nsswitch.conf', 'passwd', 'group', 'localtime', 'timezone', 'os-release', 'mime.types'];

export const MAX_FILE = 10 * 1024 * 1024;
/** What a command's output is cut to for the model and the timeline. */
const OUTPUT_LIMIT = 8_000;
const LIST_LIMIT = 500;

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  sandbox: WorkspaceStatus['sandbox'];
}

/**
 * Each Star's own folder on the server, with a terminal. Files live in
 * DATA_DIR/workspaces/<starId>. Commands run inside a bubblewrap sandbox
 * when `bwrap` is installed: the Star's folder is the only writable place,
 * the rest of the system is read-only, the person's home, the server's data
 * and every environment variable are hidden, and there is no network unless
 * the call asks for it (which then needs the person's OK).
 *
 * Without bwrap (macOS, Windows, a container without user namespaces) there
 * is no sandbox, so every command asks the person first.
 */
export class Workspaces {
  store: Store;
  config: Config;
  private rootDir: string;
  private sandbox: { kind: WorkspaceStatus['sandbox']; reason: string | null } | null = null;

  constructor(store: Store, config: Config) {
    this.store = store;
    this.config = config;
    this.rootDir = config.dbPath === ':memory:' ? mkdtempSync(join(tmpdir(), 'sky-ws-')) : join(config.dataDir, 'workspaces');
  }

  status(): WorkspaceStatus {
    const d = this.detect();
    return { sandbox: d.kind, reason: d.reason, root: this.rootDir };
  }

  /** Whether bwrap is here and actually works (it needs user namespaces). Checked once. */
  private detect() {
    if (this.sandbox) return this.sandbox;
    if (this.config.sandbox === 'none') return (this.sandbox = { kind: 'none', reason: 'Turned off with SKY_SANDBOX=none.' });
    const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', '--die-with-parent', 'true'], { timeout: 5_000 });
    if (probe.error || probe.status !== 0) {
      const why = probe.error ? 'bubblewrap (bwrap) isn’t installed' : `bwrap couldn’t start (${String(probe.stderr).trim().slice(0, 120) || `exit ${probe.status}`})`;
      return (this.sandbox = { kind: 'none', reason: `${why}, so commands aren’t sandboxed and each one asks you first. On Linux: sudo apt install bubblewrap.` });
    }
    return (this.sandbox = { kind: 'bwrap', reason: null });
  }

  sandboxed() {
    return this.detect().kind === 'bwrap';
  }

  /** The Star's folder, created on first use. */
  dir(starId: string): string {
    if (!this.store.findStar(starId)) throw notFound('Star', starId);
    const d = join(this.rootDir, starId.replace(/[^\w-]/g, '_'));
    mkdirSync(d, { recursive: true });
    return d;
  }

  /** A path inside the Star's folder. Refuses anything that leads outside it, including through a symlink. */
  resolve(starId: string, path = ''): { abs: string; rel: string } {
    const base = realpathSync(this.dir(starId));
    const clean = String(path).replace(/\\/g, '/').replace(/^\/+/, '').replace(/^workspace(\/|$)/, '');
    if (clean.includes('\0')) throw badRequest('That path isn’t valid');
    const abs = resolve(base, clean);
    if (abs !== base && !abs.startsWith(base + sep)) throw badRequest(`“${path}” is outside the workspace`);
    // Follow the deepest part that exists, so a symlink can't point out of the folder.
    let probe = abs;
    while (!existsSync(probe) && probe !== base) probe = dirname(probe);
    const real = realpathSync(probe);
    if (real !== base && !real.startsWith(base + sep)) throw badRequest(`“${path}” is outside the workspace`);
    return { abs, rel: relative(base, abs).split(sep).join('/') };
  }

  list(starId: string, path = '', recursive = false): WorkspaceFile[] {
    const { abs, rel } = this.resolve(starId, path);
    if (!existsSync(abs)) throw notFound('Folder', path || '/');
    if (!statSync(abs).isDirectory()) throw badRequest(`${path} is a file, not a folder`);
    const out: WorkspaceFile[] = [];
    const walk = (dirAbs: string, dirRel: string) => {
      for (const name of readdirSync(dirAbs).sort()) {
        if (out.length >= LIST_LIMIT) return;
        const a = join(dirAbs, name);
        const st = lstatSync(a);
        const r = dirRel ? `${dirRel}/${name}` : name;
        const folder = st.isDirectory();
        out.push({ path: r, kind: folder ? 'folder' : 'file', size: folder ? 0 : st.size, updatedAt: st.mtime.toISOString() });
        if (folder && recursive) walk(a, r);
      }
    };
    walk(abs, rel);
    return out;
  }

  read(starId: string, path: string): Buffer {
    const { abs } = this.resolve(starId, path);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw notFound('File', path);
    if (statSync(abs).size > MAX_FILE) throw new ApiError(413, 'too_large', `${path} is over ${MAX_FILE / 1024 / 1024} MB`);
    return readFileSync(abs);
  }

  write(starId: string, path: string, data: Buffer | string): WorkspaceFile {
    const { abs, rel } = this.resolve(starId, path);
    if (!rel) throw badRequest('Give a file name');
    const size = Buffer.byteLength(data);
    if (size > MAX_FILE) throw new ApiError(413, 'too_large', `Files can be up to ${MAX_FILE / 1024 / 1024} MB`);
    if (existsSync(abs) && statSync(abs).isDirectory()) throw badRequest(`${path} is a folder`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
    this.changed(starId, rel);
    return { path: rel, kind: 'file', size, updatedAt: iso() };
  }

  remove(starId: string, path: string) {
    const { abs, rel } = this.resolve(starId, path);
    if (!rel) throw badRequest('Give a file or folder, not the whole workspace');
    if (!existsSync(abs)) throw notFound('File', path);
    rmSync(abs, { recursive: true, force: true });
    this.changed(starId, rel);
  }

  /** Bytes used by a Star's folder. */
  usage(starId: string): number {
    let total = 0;
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const st = lstatSync(join(d, name));
        if (st.isDirectory()) walk(join(d, name));
        else total += st.size;
      }
    };
    walk(this.dir(starId));
    return total;
  }

  private changed(starId: string, path: string) {
    this.store.bus.emit({ type: 'workspace.changed', data: { starId, path } });
  }

  /**
   * Runs a shell command in the Star's folder. Output (stdout and stderr
   * together) is cut to the last OUTPUT_LIMIT characters. The process is
   * killed at the timeout.
   */
  async run(starId: string, command: string, opts: { network?: boolean; timeoutSec?: number } = {}): Promise<CommandResult> {
    const cwd = this.dir(starId);
    const timeout = Math.min(600, Math.max(1, opts.timeoutSec ?? 60)) * 1000;
    const kind = this.detect().kind;
    // Memory and file-size limits for whatever runs, so one command can't fill the disk or the RAM.
    const limited = `ulimit -v 2097152 2>/dev/null; ulimit -f 2097152 2>/dev/null; ${command}`;
    const env = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: kind === 'bwrap' ? '/workspace' : cwd, LANG: 'C.UTF-8', TERM: 'dumb' };
    const [file, args] = kind === 'bwrap' ? ['bwrap', this.bwrapArgs(cwd, Boolean(opts.network), limited)] : ['sh', ['-c', limited]];
    return new Promise((done) => {
      const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const take = (b: Buffer) => {
        out += b.toString('utf8');
        if (out.length > OUTPUT_LIMIT * 4) out = out.slice(-OUTPUT_LIMIT * 2);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }, timeout);
      const finish = (exitCode: number | null) => {
        clearTimeout(timer);
        const text = out.length > OUTPUT_LIMIT ? `…(earlier output cut)\n${out.slice(-OUTPUT_LIMIT)}` : out;
        this.changed(starId, '');
        done({ exitCode, output: text, timedOut, sandbox: kind });
      };
      child.on('error', (err) => { out += `\n${err.message}`; finish(null); });
      child.on('close', (code) => finish(code));
    });
  }

  private bwrapArgs(cwd: string, network: boolean, command: string): string[] {
    // The system's programs and libraries, read-only. The person's files, the server's data (database, vault key,
    // browser profile), other services' state and devices aren't there at all.
    const skip = new Set(['home', 'root', 'mnt', 'media', 'srv', 'run', 'var', 'tmp', 'proc', 'dev', 'sys', 'boot', 'lost+found', 'workspace']);
    const data = resolve(this.config.dataDir);
    const system: string[] = [];
    for (const name of readdirSync('/')) {
      const p = `/${name}`;
      // /etc is bound entry by entry below, not whole: it holds service files with passwords (like the unit file the setup guide uses).
      if (skip.has(name) || name === 'etc' || data === p || data.startsWith(`${p}/`) && !['usr', 'opt'].includes(name)) continue;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) system.push('--symlink', readlinkSync(p), p);
      else if (st.isDirectory()) system.push('--ro-bind', p, p);
    }
    // Only what programs need from /etc to run and to look up names and certificates; nothing else is there.
    const etc: string[] = [];
    for (const name of ETC_ALLOWED) {
      const p = `/etc/${name}`;
      if (!existsSync(p)) continue;
      // A link (resolv.conf often points into /run) is bound as the file it points to.
      etc.push('--ro-bind', lstatSync(p).isSymbolicLink() ? realpathSync(p) : p, p);
    }
    return [
      ...system,
      ...etc,
      // A data folder inside /usr or /opt stays hidden too.
      ...(existsSync(data) && /^\/(usr|opt)\//.test(data) ? ['--tmpfs', data] : []),
      '--bind', cwd, '/workspace',
      '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--dir', '/var/tmp',
      '--unshare-all', ...(network ? ['--share-net'] : []),
      '--uid', '1000', '--gid', '1000', '--hostname', 'sky',
      '--die-with-parent', '--new-session', '--chdir', '/workspace',
      'sh', '-c', command,
    ];
  }

}
