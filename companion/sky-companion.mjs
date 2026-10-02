#!/usr/bin/env node
// Sky companion: lets your Stars use this computer, only as far as you allow.
//
//   node sky-companion.mjs pair <sky-address> <code>   pair once, with a code from Sky
//   node sky-companion.mjs                              run it (press o to switch on/off, q to quit)
//   node sky-companion.mjs allow-folder <path>          let Stars use a folder (and what's inside it)
//   node sky-companion.mjs allow-command <program>      let Stars run a program, like git or python3
//   node sky-companion.mjs allow-open-urls on|off       let Stars open web pages in your browser
//   node sky-companion.mjs disallow-folder <path> | disallow-command <program>
//   node sky-companion.mjs confirm on|off               ask here before each action (on unless you turn it off)
//   node sky-companion.mjs status | unpair
//
// It needs Node 22 or newer and nothing else. It dials out to Sky, so this
// computer needs no open port. Nothing is allowed until you allow it, every
// action is an approval in Sky, and by default it also asks you here.

import { execFile, spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const CONFIG = process.env.SKY_COMPANION_CONFIG || join(homedir(), '.sky-companion.json');
const SOCKET_PATH = '/api/v1/companion/socket';
const MAX_READ = 2 * 1024 * 1024;
const MAX_WRITE = 5 * 1024 * 1024;
const OUTPUT_LIMIT = 8000;
const RUN_TIMEOUT_MS = 120_000;
const CONFIRM_TIMEOUT_MS = 120_000;
const WIN = platform() === 'win32';

// ---- settings file -------------------------------------------------------------

function load() {
  const base = { server: null, deviceId: null, token: null, name: hostname(), allow: { folders: [], commands: [], openUrls: false }, confirmLocally: true, enabled: true };
  if (!existsSync(CONFIG)) return base;
  try {
    const c = JSON.parse(readFileSync(CONFIG, 'utf8'));
    return { ...base, ...c, allow: { ...base.allow, ...(c.allow ?? {}) } };
  } catch {
    fail(`Couldn't read ${CONFIG}. Fix or delete it.`);
  }
}

function save(c) {
  writeFileSync(CONFIG, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(CONFIG, 0o600); } catch { /* Windows */ }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const expand = (p) => resolve(p === '~' ? homedir() : p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(2)) : p);
const same = (a, b) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);

/** True when `target` (already real) is one of the allowed folders or inside one. */
function inside(target, folders) {
  return folders.some((f) => {
    let root;
    try { root = realpathSync(expand(f)); } catch { return false; }
    const rel = relative(root, target);
    return same(target, root) || (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel));
  });
}

/** The real path of an existing file or folder, if it's allowed. Symlinks are followed before checking. */
function allowedPath(p, folders) {
  if (typeof p !== 'string' || !p) throw new Error('No path given.');
  let real;
  try { real = realpathSync(expand(p)); } catch { throw new Error(`${p} doesn't exist.`); }
  if (!inside(real, folders)) throw new Error(`${p} isn't in a folder this computer allows. Allowed: ${folders.join(', ') || 'none'}.`);
  return real;
}

const INTERPRETERS = /^(python[\d.]*|node|nodejs|deno|bun|ruby|perl|php|lua|osascript|powershell|pwsh)(\.exe)?$/i;
/** Programs that can read, write or run anything wherever they like, whatever their arguments. */
const WIDE = /^(python[\d.]*|node|nodejs|deno|bun|ruby|perl|php|lua|git|npm|npx|pnpm|yarn|pip[\d.]*|make|cmake|cargo|go|find|awk|gawk|sed|tar|zip|unzip|rsync|curl|wget|ssh|scp|docker|podman|kubectl|vim|vi|nano|emacs|less|more|man|xargs|env|osascript)(\.exe)?$/i;

/**
 * The arguments of a program are checked like paths: one that points somewhere (absolute, starting with ~, with ..,
 * or a --option=path) must resolve inside an allowed folder, so \`cat /somewhere/else\` or \`git -C ~\` doesn't reach
 * past the allowlist. Inline code (python -c, node -e) is refused. This can't make an interpreter safe: a script
 * the program runs can still reach anything. Allow only programs you'd trust with the folders you allowed.
 */
function checkArgs(program, args, cwd, folders) {
  if (INTERPRETERS.test(program) && args.some((a) => /^(-c|-e|-p|-r|--eval|--print|--command|-Command|-EncodedCommand|-enc)$/i.test(a) || /^-[a-z]*[cep]$/i.test(a) && a.length <= 3)) {
    throw new Error(`${program} can’t run code given on the command line here (-c, -e): put it in a file in an allowed folder.`);
  }
  for (const arg of args) {
    const candidates = [arg, ...(arg.startsWith('-') && arg.includes('=') ? [arg.slice(arg.indexOf('=') + 1)] : [])];
    for (const value of candidates) {
      if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) continue;
      const pathy = /^(~|\/|[A-Za-z]:[\\/]|\\\\)/.test(value) || value.split(/[\\/]/).includes('..') || /[\\/]/.test(value);
      if (!pathy) continue;
      const full = value.startsWith('~') ? expand(value) : resolve(cwd, value);
      let real;
      try { real = realpathSync(full); } catch { real = full; }
      if (!inside(real, folders)) {
        throw new Error(`The argument ${value} points outside the folders this computer allows. Allowed: ${folders.join(', ') || 'none'}.`);
      }
    }
  }
}

/** Where a file may be written: its folder must exist and be allowed, and an existing file must be allowed too. */
function allowedTarget(p, folders) {
  if (typeof p !== 'string' || !p) throw new Error('No path given.');
  const full = expand(p);
  if (existsSync(full) || isLink(full)) return allowedPath(full, folders);
  const parent = allowedPath(dirname(full), folders);
  return join(parent, basename(full));
}

function isLink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// ---- commands that change the settings ------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
if (cmd && cmd !== 'run') {
  const c = load();
  const onOff = (v) => (v === 'on' ? true : v === 'off' ? false : fail('Say on or off.'));
  switch (cmd) {
    case 'pair': {
      const [server, code] = rest;
      if (!server || !code) fail('Usage: node sky-companion.mjs pair <sky-address> <code>');
      let url;
      try { url = new URL(server); } catch { fail(`${server} isn't an address like https://sky.example.com`); }
      if (!/^https?:$/.test(url.protocol)) fail('The address must start with http:// or https://');
      if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        console.warn('Warning: this address isn’t https, so the connection isn’t encrypted. Use https outside your own machine.');
      }
      await pair(c, url.origin, code);
      break;
    }
    case 'allow-folder': {
      if (!rest[0]) fail('Usage: allow-folder <path>');
      const p = expand(rest[0]);
      if (!existsSync(p) || !statSync(p).isDirectory()) fail(`${p} isn't a folder.`);
      const real = realpathSync(p);
      if (real === realpathSync(homedir()) || real === resolve('/') || /^[A-Za-z]:\\?$/.test(real)) {
        console.warn('Warning: that is your whole home folder or drive. Stars could reach everything in it, with your OK each time.');
      }
      if (!c.allow.folders.some((f) => same(f, real))) c.allow.folders.push(real);
      save(c);
      console.log(`Allowed folder: ${real}`);
      break;
    }
    case 'disallow-folder': {
      const p = rest[0] ? expand(rest[0]) : fail('Usage: disallow-folder <path>');
      c.allow.folders = c.allow.folders.filter((f) => !same(f, p) && !(existsSync(p) && same(f, realpathSync(p))));
      save(c);
      console.log(`Folders now: ${c.allow.folders.join(', ') || 'none'}`);
      break;
    }
    case 'allow-command': {
      const name = rest[0];
      if (!name || /[\\/\s]/.test(name)) fail('Give a program name like git or python3 (no path, no arguments).');
      if (/^(sh|bash|zsh|fish|dash|ksh|cmd|powershell|pwsh|sudo|su|doas|env|xargs)(\.exe)?$/i.test(name)) {
        console.warn(`Warning: ${name} can run any other program, which makes the program allowlist meaningless.`);
      } else if (WIDE.test(name)) {
        console.warn(`Warning: ${name} can read and change files anywhere your account can, whatever folders you allowed: an argument is checked, but a script or setting it runs isn’t. Allow it only if you trust Stars with that.`);
      }
      if (!c.allow.commands.includes(name)) c.allow.commands.push(name);
      save(c);
      console.log(`Allowed program: ${name}`);
      break;
    }
    case 'disallow-command':
      c.allow.commands = c.allow.commands.filter((x) => x !== rest[0]);
      save(c);
      console.log(`Programs now: ${c.allow.commands.join(', ') || 'none'}`);
      break;
    case 'allow-open-urls':
      c.allow.openUrls = onOff(rest[0]);
      save(c);
      console.log(`Opening web pages: ${c.allow.openUrls ? 'allowed' : 'not allowed'}`);
      break;
    case 'confirm':
      c.confirmLocally = onOff(rest[0]);
      save(c);
      console.log(c.confirmLocally ? 'Each action asks here first.' : 'Actions no longer ask here (Sky still asks you every time).');
      break;
    case 'name':
      c.name = rest.join(' ').trim() || hostname();
      save(c);
      console.log(`This computer is called ${c.name} in Sky (after it next connects).`);
      break;
    case 'status':
      console.log(JSON.stringify({ ...c, token: c.token ? '(saved)' : null }, null, 2));
      break;
    case 'unpair':
      save({ ...c, server: null, deviceId: null, token: null });
      console.log('Unpaired. Remove it in Sky too (Settings → Your computer).');
      break;
    default:
      fail(`Unknown command ${cmd}. Run it with no command to connect, or see the top of this file.`);
  }
  if (cmd !== 'pair') process.exit(0);
} else {
  const c = load();
  if (!c.token) fail('Not paired yet. In Sky, open Settings → Your computer, make a code, then run:\n  node sky-companion.mjs pair <sky-address> <code>');
  connect(c);
}

// ---- pairing --------------------------------------------------------------------

function wsUrl(server) {
  return `${server.replace(/^http/, 'ws')}${SOCKET_PATH}`;
}

function device(c) {
  return { name: c.name || hostname(), platform: `${platform()}` };
}

function pair(c, server, code) {
  return new Promise((done) => {
    const ws = new WebSocket(wsUrl(server));
    ws.onopen = () => ws.send(JSON.stringify({ type: 'pair', code, device: device(c), allow: c.allow, confirmLocally: c.confirmLocally }));
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === 'paired') {
        save({ ...c, server, deviceId: msg.deviceId, token: msg.token });
        console.log(`Paired with ${server}.`);
        if (!c.allow.folders.length && !c.allow.commands.length && !c.allow.openUrls) {
          console.log('Nothing is allowed yet. Add what Stars may use, for example:\n  node sky-companion.mjs allow-folder ~/Documents/Sky\n  node sky-companion.mjs allow-command git');
        }
        console.log('Then run: node sky-companion.mjs');
        ws.close();
        done();
        process.exit(0);
      } else if (msg.type === 'error') {
        fail(msg.message);
      }
    };
    ws.onerror = () => fail(`Couldn't reach ${server}. Check the address and that Sky is running.`);
  });
}

// ---- running --------------------------------------------------------------------

function connect(c) {
  let ws = null;
  let backoff = 1000;
  let stopped = false;
  let skyEnabled = true;
  let connected = false;
  /** Waiting actions, confirmed one at a time. */
  const queue = [];
  let asking = null;

  const line = () => {
    const on = c.enabled ? '\x1b[42m\x1b[30m ON \x1b[0m' : '\x1b[41m\x1b[37m OFF \x1b[0m';
    const net = connected ? `connected to ${c.server}` : 'not connected';
    const sky = skyEnabled ? '' : ' (switched off in Sky)';
    return `${on} Stars ${c.enabled && skyEnabled ? 'may use' : 'can’t use'} this computer${sky}. ${net}. Press o to switch ${c.enabled ? 'off' : 'on'}, q to quit.`;
  };
  const show = (text) => {
    if (asking) return;
    console.log(text ?? line());
  };

  const sendState = () => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'state', enabled: c.enabled, allow: c.allow }));
  };

  // The allowlist and the confirm setting can change while it runs (allow-folder from another terminal).
  watchFile(CONFIG, { interval: 1000 }, () => {
    let fresh;
    try { fresh = JSON.parse(readFileSync(CONFIG, 'utf8')); } catch { return; }
    fresh.allow = { folders: [], commands: [], openUrls: false, ...(fresh.allow ?? {}) };
    c.allow = fresh.allow;
    c.confirmLocally = fresh.confirmLocally;
    sendState();
    show(`Allowlist updated: folders ${c.allow.folders.join(', ') || 'none'}; programs ${c.allow.commands.join(', ') || 'none'}; pages ${c.allow.openUrls ? 'yes' : 'no'}.`);
  });

  const open = () => {
    if (stopped) return;
    ws = new WebSocket(wsUrl(c.server));
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', deviceId: c.deviceId, token: c.token, device: device(c), allow: c.allow, enabled: c.enabled, confirmLocally: c.confirmLocally }));
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      if (msg.type === 'ready') {
        connected = true;
        backoff = 1000;
        skyEnabled = msg.enabled !== false;
        show();
      } else if (msg.type === 'switch') {
        skyEnabled = msg.enabled !== false;
        show();
      } else if (msg.type === 'unpaired') {
        stopped = true;
        save({ ...c, server: null, deviceId: null, token: null });
        console.log('Sky unpaired this computer. Pair it again with a new code to use it.');
        quit(0);
      } else if (msg.type === 'error') {
        console.log(`Sky said: ${msg.message}`);
        if (/isn’t paired|isn't paired/.test(msg.message)) {
          stopped = true;
          quit(1);
        }
      } else if (msg.type === 'call') {
        queue.push(msg);
        void next();
      }
    };
    ws.onclose = () => {
      const was = connected;
      connected = false;
      // Anything waiting can't be answered on this connection.
      queue.splice(0);
      if (stopped) return;
      if (was) show();
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
    ws.onerror = () => { /* onclose follows */ };
  };

  const reply = (id, ok, body) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id, ok, ...(ok ? { output: body } : { error: body }) }));
  };

  const next = async () => {
    if (asking || !queue.length) return;
    const call = queue.shift();
    try {
      if (!c.enabled) throw new Error('Using this computer is switched off on the computer itself.');
      const what = describe(call);
      check(call, c.allow);
      if (c.confirmLocally) {
        const yes = await confirm(`${call.star ?? 'A Star'} wants to ${what}${call.why ? `\n  for: ${call.why}` : ''}\n  Allow? [y/N] `);
        if (!yes) throw new Error('The person said no on the computer.');
      } else {
        console.log(`${call.star ?? 'A Star'}: ${what}`);
      }
      reply(call.id, true, await perform(call, c.allow));
    } catch (err) {
      reply(call.id, false, err instanceof Error ? err.message : String(err));
    }
    void next();
  };

  // ---- the keyboard: a visible on/off switch, and answers to "Allow?" ----

  let answer = null;
  const confirm = (question) => new Promise((done) => {
    if (!process.stdin.isTTY) {
      console.log(`${question}\n(no keyboard here, so the answer is no. Run it in a terminal, or turn off "confirm".)`);
      return done(false);
    }
    asking = true;
    process.stdout.write(`\x07\n${question}`);
    const timer = setTimeout(() => finish(false, '(no answer, so no)'), CONFIRM_TIMEOUT_MS);
    const finish = (yes, note) => {
      clearTimeout(timer);
      answer = null;
      asking = null;
      process.stdout.write(`${note ?? (yes ? 'yes' : 'no')}\n`);
      show();
      done(yes);
    };
    answer = (key) => finish(key === 'y' || key === 'Y');
  });

  const toggle = () => {
    c.enabled = !c.enabled;
    const saved = load();
    save({ ...saved, enabled: c.enabled });
    sendState();
    show();
  };

  function quit(code = 0) {
    stopped = true;
    unwatchFile(CONFIG);
    try { process.stdin.setRawMode?.(false); } catch { /* not a TTY */ }
    ws?.close();
    process.exit(code);
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key) => {
      if (key === '\u0003') return quit(0);
      if (answer) return answer(key);
      if (key === 'o' || key === 'O') toggle();
      else if (key === 'q' || key === 'Q') quit(0);
    });
  } else {
    // Without a keyboard there is no local switch, so say how to stop it.
    createInterface({ input: process.stdin }).on('line', (l) => {
      if (l.trim() === 'off' || l.trim() === 'on') { if ((l.trim() === 'on') !== c.enabled) toggle(); }
    });
    console.log('No keyboard: type on or off and press Enter to switch, or stop the program to quit.');
  }
  process.on('SIGINT', () => quit(0));
  process.on('SIGTERM', () => quit(0));

  show(`Sky companion for ${c.name || hostname()}. Folders: ${c.allow.folders.join(', ') || 'none'}. Programs: ${c.allow.commands.join(', ') || 'none'}. Pages: ${c.allow.openUrls ? 'yes' : 'no'}.`);
  show();
  open();
}

// ---- what a Star may ask for ------------------------------------------------------

function describe(call) {
  const a = call.args ?? {};
  switch (call.action) {
    case 'open_url': return `open ${a.url} in your browser`;
    case 'list_files': return `list the folder ${a.path}`;
    case 'read_file': return `read the file ${a.path}`;
    case 'write_file': return `${a.append ? 'add to' : 'write'} the file ${a.path} (${Buffer.byteLength(String(a.content ?? ''))} bytes)`;
    case 'run': return `run: ${[a.program, ...(a.args ?? [])].join(' ')}${a.folder ? `\n  in: ${a.folder}` : ''}`;
    default: throw new Error(`Unknown action ${call.action}.`);
  }
}

/** The allowlist, checked before asking the person (and again by perform, on real paths). */
function check(call, allow) {
  const a = call.args ?? {};
  if (call.action === 'open_url') {
    if (!allow.openUrls) throw new Error('Opening web pages isn’t allowed on this computer.');
    if (!/^https?:\/\/[^\s]+$/i.test(String(a.url ?? ''))) throw new Error('Only http and https pages can be opened.');
  } else if (call.action === 'run') {
    if (typeof a.program !== 'string' || /[\\/]/.test(a.program) || !allow.commands.includes(a.program)) {
      throw new Error(`${a.program} isn’t a program this computer allows. Allowed: ${allow.commands.join(', ') || 'none'}.`);
    }
    if (a.args !== undefined && (!Array.isArray(a.args) || a.args.some((x) => typeof x !== 'string'))) throw new Error('args must be a list of text.');
    if (!allow.folders.length) throw new Error('No folder is allowed to run programs in.');
    checkArgs(a.program, a.args ?? [], allowedPath(a.folder || allow.folders[0], allow.folders), allow.folders);
  } else if (!['list_files', 'read_file', 'write_file'].includes(call.action)) {
    throw new Error(`Unknown action ${call.action}.`);
  }
}

async function perform(call, allow) {
  const a = call.args ?? {};
  switch (call.action) {
    case 'open_url': {
      const url = new URL(a.url).toString();
      const [prog, args] = platform() === 'darwin' ? ['open', [url]] : WIN ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
      spawn(prog, args, { detached: true, stdio: 'ignore' }).unref();
      return `Opened ${url}.`;
    }
    case 'list_files': {
      const dir = allowedPath(a.path, allow.folders);
      if (!statSync(dir).isDirectory()) throw new Error(`${a.path} isn’t a folder.`);
      const entries = readdirSync(dir, { withFileTypes: true }).slice(0, 500);
      return entries.map((e) => {
        if (e.isDirectory()) return `${e.name}/`;
        try { return `${e.name} (${statSync(join(dir, e.name)).size} bytes)`; } catch { return e.name; }
      }).join('\n') || '(empty folder)';
    }
    case 'read_file': {
      const file = allowedPath(a.path, allow.folders);
      const st = statSync(file);
      if (!st.isFile()) throw new Error(`${a.path} isn’t a file.`);
      if (st.size > MAX_READ) throw new Error(`${a.path} is ${st.size} bytes; files up to ${MAX_READ} bytes can be read.`);
      const data = readFileSync(file);
      if (data.subarray(0, 8000).includes(0)) return `${a.path} is a binary file (${data.length} bytes).`;
      return data.toString('utf8');
    }
    case 'write_file': {
      const content = String(a.content ?? '');
      if (Buffer.byteLength(content) > MAX_WRITE) throw new Error(`That’s more than ${MAX_WRITE} bytes.`);
      const file = allowedTarget(a.path, allow.folders);
      if (existsSync(file) && !statSync(file).isFile()) throw new Error(`${a.path} isn’t a file.`);
      if (a.append) appendFileSync(file, content);
      else writeFileSync(file, content);
      return `Saved ${file} (${statSync(file).size} bytes).`;
    }
    case 'run': {
      if (!allow.folders.length) throw new Error('No folder is allowed to run programs in.');
      const cwd = allowedPath(a.folder || allow.folders[0], allow.folders);
      if (!statSync(cwd).isDirectory()) throw new Error(`${a.folder} isn’t a folder.`);
      checkArgs(a.program, a.args ?? [], cwd, allow.folders);
      return new Promise((done) => {
        // No shell: the arguments go to the program as they are, so ; | && and $() mean nothing.
        execFile(a.program, a.args ?? [], { cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, shell: false, windowsHide: true }, (err, stdout, stderr) => {
          const out = `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim();
          const status = err ? (err.killed ? 'stopped at the time limit' : err.code === 'ENOENT' ? `${a.program} isn’t installed` : `exit ${err.code ?? '?'}`) : 'exit 0';
          done(`${status}\n${out.length > OUTPUT_LIMIT ? `…${out.slice(-OUTPUT_LIMIT)}` : out || '(no output)'}`);
        });
      });
    }
    default:
      throw new Error(`Unknown action ${call.action}.`);
  }
}
