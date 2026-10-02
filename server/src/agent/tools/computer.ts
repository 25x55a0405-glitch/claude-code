import type { CompanionAction } from '../../companion.ts';
import type { CompanionDevice } from '../../types.ts';
import { firstLine } from '../../util.ts';
import { bool, schema, str, type ToolContext, type ToolDef, type ToolEnv } from './types.ts';

const READ_LIMIT = 60_000;
/** Content written on the person's computer has to fit in the approval, all of it. */
const WRITE_LIMIT = 20_000;
/** Every action on the person's computer is an approval, whatever the Star's autonomy. */
const ALWAYS = 'It’s on your own computer, so Stars always ask first.';

const computer = { computer: str('Which computer, by name; leave empty when only one is connected') };
const strings = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

function device(env: ToolEnv | ToolContext | undefined, name?: string): CompanionDevice | null {
  try {
    return env?.companion?.pick(name) ?? null;
  } catch {
    return null;
  }
}

const where = (env: ToolEnv | undefined, name?: string) => device(env, name)?.name ?? name ?? 'your computer';


async function call(ctx: ToolContext, name: string | undefined, action: CompanionAction, args: Record<string, unknown>, check?: (d: CompanionDevice) => string | null): Promise<string> {
  if (!ctx.companion) throw new Error('The companion isn’t available on this server.');
  const d = ctx.companion.pick(name);
  const refused = check?.(d);
  if (refused) throw new Error(refused);
  return ctx.companion.call(d, action, args, { star: ctx.star.name, why: ctx.task?.title ?? 'A chat with the person' });
}

/**
 * A first look at the allowlist, so a Star gets a clear answer before anyone is asked. Only the companion can
 * check a path for real (it expands ~ and follows links), so here an empty list is the only refusal.
 */
const folderCheck = (_path: string) => (d: CompanionDevice) =>
  d.allow.folders.length ? null : `${d.name} hasn’t allowed any folders. The person adds them on the computer itself (allow-folder).`;

export const computerOpen: ToolDef<{ url: string; computer?: string }> = {
  name: 'computer_open',
  description: 'Open a web page in the person’s own browser on their computer (through the Sky companion), for example to show them something or to hand over a page. Needs the person’s OK.',
  input_schema: schema({ url: str('The http or https address'), ...computer }, ['url']),
  effect: 'write',
  connection: 'computer',
  scope: 'task',
  mustAsk: () => ALWAYS,
  approval: (i, env) => ({ action: 'Open a page on your computer', target: where(env, i.computer), preview: i.url, risk: 'medium' }),
  applyEdit: (i, edited) => ({ ...i, url: edited.trim() }),
  label: (i) => `Opened ${firstLine(i.url, 80)} on your computer`,
  async run(i, ctx) {
    if (!/^https?:\/\//i.test(i.url)) throw new Error('Only http and https pages can be opened.');
    return call(ctx, i.computer, 'open_url', { url: i.url }, (d) => (d.allow.openUrls ? null : `${d.name} doesn’t allow opening pages. The person can turn it on in the companion.`));
  },
};

export const computerListFiles: ToolDef<{ path: string; computer?: string }> = {
  name: 'computer_list_files',
  description: 'List a folder on the person’s computer. Only folders they allowed in the companion can be used (they’re listed in the error if you pick another); paths are absolute or start with ~. Needs the person’s OK.',
  input_schema: schema({ path: str('The folder, e.g. ~/Documents/Invoices'), ...computer }, ['path']),
  effect: 'read',
  connection: 'computer',
  scope: 'task',
  mustAsk: () => ALWAYS,
  approval: (i, env) => ({ action: `List ${firstLine(i.path, 80)}`, target: where(env, i.computer), preview: `See the names of the files in ${i.path}.`, risk: 'medium' }),
  label: (i) => `Listed ${firstLine(i.path, 80)} on your computer`,
  async run(i, ctx) {
    return call(ctx, i.computer, 'list_files', { path: i.path }, folderCheck(i.path));
  },
};

export const computerReadFile: ToolDef<{ path: string; computer?: string }> = {
  name: 'computer_read_file',
  description: 'Read a text file on the person’s computer, inside a folder they allowed. Needs the person’s OK.',
  input_schema: schema({ path: str('The file, absolute or starting with ~'), ...computer }, ['path']),
  effect: 'read',
  connection: 'computer',
  scope: 'task',
  mustAsk: () => ALWAYS,
  approval: (i, env) => ({ action: `Read ${firstLine(i.path, 80)}`, target: where(env, i.computer), preview: `Read the file ${i.path}.`, risk: 'medium' }),
  label: (i) => `Read ${firstLine(i.path, 80)} on your computer`,
  async run(i, ctx) {
    const text = await call(ctx, i.computer, 'read_file', { path: i.path }, folderCheck(i.path));
    return text.length > READ_LIMIT ? `${text.slice(0, READ_LIMIT)}\n…(cut at ${READ_LIMIT} characters of ${text.length})` : text || '(empty file)';
  },
};

export const computerWriteFile: ToolDef<{ path: string; content: string; append?: boolean; computer?: string }> = {
  name: 'computer_write_file',
  description: 'Write a text file on the person’s computer, inside a folder they allowed, replacing it unless append is set. Needs the person’s OK.',
  input_schema: schema({ path: str('The file, absolute or starting with ~'), content: str(`What to write, at most ${WRITE_LIMIT} characters (the person reads all of it before approving; use several files for more)`, { maxLength: WRITE_LIMIT }), append: bool('Add to the end instead of replacing'), ...computer }, ['path', 'content']),
  effect: 'write',
  connection: 'computer',
  scope: 'task',
  mustAsk: () => ALWAYS,
  approval: (i, env) => ({ action: `${i.append ? 'Add to' : 'Write'} ${firstLine(i.path, 70)}`, target: where(env, i.computer), preview: i.content, risk: 'high' }),
  applyEdit: (i, edited) => ({ ...i, content: edited }),
  label: (i) => `${i.append ? 'Added to' : 'Wrote'} ${firstLine(i.path, 80)} on your computer`,
  async run(i, ctx) {
    return call(ctx, i.computer, 'write_file', { path: i.path, content: i.content, append: Boolean(i.append) }, folderCheck(i.path));
  },
};

export const computerRun: ToolDef<{ program: string; args?: string[]; folder?: string; computer?: string }> = {
  name: 'computer_run',
  description: 'Run a program on the person’s computer. Only programs they allowed in the companion can run, with no shell (so no pipes or ;), '
    + 'in a folder they allowed. Output is cut to the last 8000 characters. Needs the person’s OK every time.',
  input_schema: schema({
    program: str('The program, e.g. git or python3'),
    args: strings('Its arguments, one per item'),
    folder: str('The folder to run it in (an allowed folder); the first allowed folder by default'),
    ...computer,
  }, ['program']),
  effect: 'write',
  connection: 'computer',
  scope: 'task',
  mustAsk: () => ALWAYS,
  approval: (i, env) => ({
    action: `Run ${firstLine(i.program, 40)}`,
    target: where(env, i.computer),
    preview: `${[i.program, ...(i.args ?? [])].map(quote).join(' ')}${i.folder ? `\n(in ${i.folder})` : ''}`,
    risk: 'high',
  }),
  label: (i) => `Ran ${firstLine([i.program, ...(i.args ?? [])].join(' '), 70)} on your computer`,
  async run(i, ctx) {
    const args = Array.isArray(i.args) ? i.args.map(String) : [];
    return call(ctx, i.computer, 'run', { program: i.program, args, folder: i.folder }, (d) => {
      const name = i.program.replace(/\\/g, '/').split('/').pop()!.replace(/\.exe$/i, '').toLowerCase();
      if (!d.allow.commands.some((c) => c.toLowerCase() === name)) {
        return `${i.program} isn’t a program ${d.name} allows. Allowed: ${d.allow.commands.join(', ') || 'none yet'}. The person adds programs on the computer itself.`;
      }
      return i.folder ? folderCheck(i.folder)(d) : d.allow.folders.length ? null : `${d.name} has no allowed folder to run in.`;
    });
  },
};

const quote = (s: string) => (/^[\w./:@=+-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

export const computerTools: ToolDef[] = [computerOpen, computerListFiles, computerReadFile, computerWriteFile, computerRun];
