import { firstLine } from '../../util.ts';
import { bool, num, schema, str, type ToolContext, type ToolDef, type ToolEnv } from './types.ts';

const READ_LIMIT = 60_000;
const PREVIEW_LIMIT = 2000;

function ws(ctx: ToolContext) {
  if (!ctx.workspaces) throw new Error('Workspaces aren’t available on this server.');
  return ctx.workspaces;
}

const sandboxed = (env?: ToolEnv) => Boolean(env?.workspaces?.sandboxed());

export const filesList: ToolDef<{ path?: string }> = {
  name: 'files_list',
  description: 'List the files in your workspace: your own folder that keeps files between tasks. Paths are relative to it.',
  input_schema: schema({ path: str('A folder inside the workspace; empty for the top') }),
  effect: 'read',
  label: (i) => `Listed ${i.path ? `“${firstLine(i.path, 60)}”` : 'my files'}`,
  async run(i, ctx) {
    const files = ws(ctx).list(ctx.star.id, i.path ?? '', true);
    if (!files.length) return 'The folder is empty.';
    return files.map((f) => (f.kind === 'folder' ? `${f.path}/` : `${f.path} (${f.size} bytes)`)).join('\n');
  },
};

export const fileRead: ToolDef<{ path: string }> = {
  name: 'file_read',
  description: 'Read a text file from your workspace.',
  input_schema: schema({ path: str('The file, relative to the workspace') }, ['path']),
  effect: 'read',
  label: (i) => `Read ${firstLine(i.path, 80)}`,
  async run(i, ctx) {
    const data = ws(ctx).read(ctx.star.id, i.path);
    if (data.subarray(0, 8000).includes(0)) return `${i.path} is a binary file (${data.length} bytes).`;
    const text = data.toString('utf8');
    return text.length > READ_LIMIT ? `${text.slice(0, READ_LIMIT)}\n…(cut at ${READ_LIMIT} characters of ${text.length})` : text || '(empty file)';
  },
};

export const fileWrite: ToolDef<{ path: string; content: string; append?: boolean }> = {
  name: 'file_write',
  description: 'Write a text file in your workspace (creating folders as needed), replacing it unless append is set. '
    + 'Use it for notes, drafts, data and scripts you want to keep between tasks.',
  input_schema: schema({ path: str('The file, relative to the workspace'), content: str('What to write'), append: bool('Add to the end instead of replacing') }, ['path', 'content']),
  // Only the Star's own folder changes, so this is a write the person can undo, never a send.
  effect: 'write',
  approval: (i) => ({
    action: `Write ${firstLine(i.path, 60)}`, target: 'the workspace',
    preview: i.content.length > PREVIEW_LIMIT ? `${i.content.slice(0, PREVIEW_LIMIT)}\n…(the first ${PREVIEW_LIMIT} of ${i.content.length} characters; it only goes in the Star’s own folder)` : i.content,
  }),
  // The preview is edited as the whole file, so it can only be edited when it shows all of it.
  applyEdit: (i, edited) => ({ ...i, content: edited }),
  canEdit: (i) => i.content.length <= PREVIEW_LIMIT,
  label: (i) => `${i.append ? 'Added to' : 'Wrote'} ${firstLine(i.path, 80)}`,
  async run(i, ctx) {
    const w = ws(ctx);
    let content: string | Buffer = i.content;
    if (i.append) {
      try {
        content = Buffer.concat([w.read(ctx.star.id, i.path), Buffer.from(i.content)]);
      } catch { /* a new file */ }
    }
    const f = w.write(ctx.star.id, i.path, content);
    return `Saved ${f.path} (${f.size} bytes).`;
  },
};

export const fileDelete: ToolDef<{ path: string }> = {
  name: 'file_delete',
  description: 'Delete a file or folder in your workspace.',
  input_schema: schema({ path: str('The file or folder, relative to the workspace') }, ['path']),
  effect: 'write',
  approval: (i) => ({ action: `Delete ${firstLine(i.path, 60)}`, target: 'the workspace', preview: `Delete ${i.path} from the workspace.` }),
  label: (i) => `Deleted ${firstLine(i.path, 80)}`,
  async run(i, ctx) {
    ws(ctx).remove(ctx.star.id, i.path);
    return `Deleted ${i.path}.`;
  },
};

export const runCommand: ToolDef<{ command: string; network?: boolean; timeout_seconds?: number }> = {
  name: 'run_command',
  description: 'Run a shell command in your workspace (your folder is the current directory; files you make there stay). '
    + 'It runs in a sandbox: only your folder can be changed and there is no internet unless you set network, which needs the person’s OK. '
    + 'Use it to process files, run scripts (python3, node, sh) and check results. Output is cut to the last 8000 characters.',
  input_schema: schema({
    command: str('The command, run with sh -c'),
    network: bool('Allow internet access (asks the person first)'),
    timeout_seconds: num('Stop it after this many seconds (default 60, at most 600)'),
  }, ['command']),
  effect: 'write',
  scope: 'task',
  applyEdit: (i, edited) => ({ ...i, command: edited }),
  // Sandboxed and offline it only changes the Star's folder; online it reaches out, so it's a send.
  effectFor: (i, env) => (i.network || !sandboxed(env) ? 'send' : 'write'),
  mustAsk: (_i, env) => (sandboxed(env) ? null : 'There’s no sandbox on this server, so a command could change anything the server can.'),
  approval: (i, env) => ({
    action: i.network ? 'Run a command with internet access' : 'Run a command',
    target: sandboxed(env) ? 'the workspace' : 'the server (not sandboxed)',
    preview: i.command,
    ...(sandboxed(env) ? {} : { risk: 'high' as const }),
  }),
  label: (i) => `Ran \`${firstLine(i.command, 70)}\``,
  async run(i, ctx) {
    const r = await ws(ctx).run(ctx.star.id, i.command, { network: i.network, timeoutSec: i.timeout_seconds });
    const status = r.timedOut ? 'stopped at the time limit' : r.exitCode === 0 ? 'exit 0' : `exit ${r.exitCode ?? '?'}`;
    return {
      content: `${status}\n${r.output.trim() || '(no output)'}`,
      summary: `Ran \`${firstLine(i.command, 70)}\` (${status})`,
    };
  },
};

export const workspaceTools: ToolDef[] = [filesList, fileRead, fileWrite, fileDelete, runCommand];
