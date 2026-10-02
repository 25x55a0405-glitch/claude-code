import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolDef } from './agent/tools/types.ts';
import type { Store } from './store.ts';
import type { McpEffect, McpServer, McpToolInfo, Star } from './types.ts';
import { ApiError, badRequest, firstLine, iso, notFound, truncate, uid } from './util.ts';
import type { Vault } from './vault.ts';

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_RESULT = 20_000;
const EFFECTS: McpEffect[] = ['read', 'write', 'send', 'delete', 'spend'];

/** What's kept on the server only: environment variables and headers, which often hold keys. */
interface McpPrivate {
  env: Record<string, string>;
  headers: Record<string, string>;
}

export interface McpInput {
  name: string;
  transport: 'stdio' | 'http';
  command?: string | null;
  args?: string[];
  url?: string | null;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
  toolEffects?: Record<string, McpEffect>;
}

interface Live {
  client: Client;
  tools: ToolDef[];
}

/**
 * Model Context Protocol servers: any tool, not just the built-in apps.
 * Local servers run as a command on the Sky server (stdio); remote ones are
 * reached over Streamable HTTP. Values in their environment or headers can be
 * {{secret:NAME}}, filled from the vault when connecting.
 *
 * Every MCP tool gets an effect (read, write, send, delete, spend), which the
 * person sets per tool, so the policy still decides what needs an approval.
 * The server's own hints are untrusted (a tool called "wipe" can say it's
 * read-only), so until the person sets an effect a tool counts as at least a
 * write, isn't offered in chat, and every call asks first. Stars only see the servers they're
 * given (Star.mcpServerIds), since many tools crowd small free models.
 */
export class McpManager {
  store: Store;
  vault?: Vault;
  private live = new Map<string, Live>();
  private connecting = new Map<string, Promise<void>>();

  constructor(store: Store, vault?: Vault) {
    this.store = store;
    this.vault = vault;
  }

  list(): McpServer[] {
    return this.store.db.all<McpServer>('mcp').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): McpServer {
    const s = this.store.db.get<McpServer>('mcp', id);
    if (!s) throw notFound('MCP server', id);
    return s;
  }

  create(input: McpInput): McpServer {
    this.check(input);
    if (this.list().some((s) => s.name.toLowerCase() === input.name.toLowerCase())) throw new ApiError(409, 'conflict', `There’s already an MCP server called ${input.name}`);
    const now = iso();
    const server = this.put({
      id: uid('mcp'), name: input.name, transport: input.transport, command: input.command ?? null, args: input.args ?? [], url: input.url ?? null,
      envKeys: [], headerKeys: [], enabled: input.enabled ?? true, toolEffects: input.toolEffects ?? {},
      status: 'off', error: null, tools: [], createdAt: now, updatedAt: now,
    }, { env: input.env ?? {}, headers: input.headers ?? {} });
    if (server.enabled) void this.connect(server.id);
    return server;
  }

  async patch(id: string, input: Partial<McpInput>): Promise<McpServer> {
    const current = this.get(id);
    const priv = this.private(id);
    const next = { ...current, ...pick(input, ['name', 'transport', 'command', 'args', 'url', 'enabled', 'toolEffects']), updatedAt: iso() } as McpServer;
    this.check({ ...next, ...priv, ...pick(input, ['env', 'headers']) });
    const reconnect = ['transport', 'command', 'args', 'url', 'env', 'headers', 'enabled'].some((k) => (input as Record<string, unknown>)[k] !== undefined);
    const saved = this.put({ ...next, tools: next.tools.map((t) => ({ ...t, ...effectOf(next.toolEffects[t.name], t.hint ?? t.effect) })) },
      { env: input.env ?? priv.env, headers: input.headers ?? priv.headers });
    if (reconnect) {
      await this.disconnect(id);
      if (saved.enabled) await this.connect(id);
      else this.status(id, 'off', null);
    }
    return this.get(id);
  }

  async delete(id: string) {
    this.get(id);
    await this.disconnect(id);
    this.store.db.delete('mcp', id);
    for (const star of this.store.listStars()) {
      if (star.mcpServerIds?.includes(id)) this.store.patchStar(star.id, { mcpServerIds: star.mcpServerIds.filter((x) => x !== id) });
    }
    this.store.bus.emit({ type: 'mcp.deleted', data: { id } });
  }

  /** Connects every enabled server. Failures are recorded on the server, not thrown. */
  async start() {
    await Promise.all(this.list().filter((s) => s.enabled).map((s) => this.connect(s.id)));
  }

  async stop() {
    await Promise.all([...this.live.keys()].map((id) => this.disconnect(id)));
  }

  connect(id: string): Promise<void> {
    const running = this.connecting.get(id);
    if (running) return running;
    const p = this.connectNow(id).finally(() => this.connecting.delete(id));
    this.connecting.set(id, p);
    return p;
  }

  private async connectNow(id: string) {
    const server = this.get(id);
    await this.disconnect(id);
    this.status(id, 'connecting', null);
    const client = new Client({ name: 'sky', version: '0.1.0' });
    try {
      const priv = this.private(id);
      const fill = (o: Record<string, string>) => (this.vault ? this.vault.fillAny(o) : o);
      let transport: Transport;
      if (server.transport === 'stdio') {
        transport = new StdioClientTransport({ command: server.command!, args: server.args, env: { ...getDefaultEnvironment(), ...fill(priv.env) }, stderr: 'ignore' });
      } else {
        transport = new StreamableHTTPClientTransport(new URL(server.url!), { requestInit: { headers: fill(priv.headers) } });
      }
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `${server.name} didn’t answer within ${CONNECT_TIMEOUT_MS / 1000}s`);
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `${server.name} didn’t list its tools`);
      const prefix = this.prefix(server);
      const used = new Set<string>();
      const infos: McpToolInfo[] = listed.tools.map((t) => {
        const hint = effectFromHints(t.annotations);
        return {
          name: t.name, toolName: unique(toolName(prefix, t.name), used), description: firstLine(t.description ?? '', 300),
          ...effectOf(server.toolEffects[t.name], hint), hint,
        };
      });
      const defs = listed.tools.map((t, i) => this.toolDef(server, client, infos[i], t.inputSchema as ToolDef['input_schema']));
      this.live.set(id, { client, tools: defs });
      client.onclose = () => {
        if (this.live.get(id)?.client === client) {
          this.live.delete(id);
          this.status(id, 'error', 'The server closed the connection');
        }
      };
      this.put({ ...this.get(id), status: 'ready', error: null, tools: infos, updatedAt: iso() });
    } catch (err) {
      await client.close().catch(() => {});
      this.status(id, 'error', this.scrub(id, err instanceof Error ? err.message : String(err)));
    }
  }

  /**
   * A server's error can repeat what it was sent (`Invalid key: Bearer …`). Filled-in header and env values
   * and vault secrets never stay in it.
   */
  private scrub(id: string, message: string): string {
    const priv = this.private(id);
    const raw = [...Object.values(priv.env), ...Object.values(priv.headers)];
    const filled = this.vault ? raw.map((v) => this.vault!.fillAny(v)) : raw;
    const values = [...filled, ...filled.flatMap((v) => v.split(/\s+/))].filter((v) => v.length >= 6).sort((a, b) => b.length - a.length);
    let out = message;
    for (const v of values) out = out.split(v).join('[hidden]');
    return this.vault ? this.vault.redact(out) : out;
  }

  /**
   * The start of this server's tool names. Servers whose names clean up the same (the first 20 characters)
   * share it only once: the later ones, by when they were added, get a short tag from their id.
   */
  private prefix(server: McpServer): string {
    const base = cleanName(server.name).slice(0, 20);
    const first = this.list().find((s) => cleanName(s.name).slice(0, 20) === base);
    return !first || first.id === server.id ? base : `${base.slice(0, 14)}_${server.id.replace(/[^a-z0-9]/gi, '').slice(-5).toLowerCase()}`;
  }

  private async disconnect(id: string) {
    const live = this.live.get(id);
    if (!live) return;
    this.live.delete(id);
    await live.client.close().catch(() => {});
  }

  /** The MCP tools a Star may use right now. */
  toolsFor(star?: Star): ToolDef[] {
    const out: ToolDef[] = [];
    for (const [id, live] of this.live) {
      if (star?.mcpServerIds && !star.mcpServerIds.includes(id)) continue;
      out.push(...live.tools);
    }
    return out;
  }

  find(name: string): ToolDef | undefined {
    for (const live of this.live.values()) {
      const t = live.tools.find((x) => x.name === name);
      if (t) return t;
    }
    return undefined;
  }

  private toolDef(server: McpServer, client: Client, info: McpToolInfo, inputSchema: ToolDef['input_schema']): ToolDef {
    return {
      name: info.toolName,
      description: `${info.description || info.name} (from ${server.name})`.slice(0, 1000),
      input_schema: { ...inputSchema, type: 'object', properties: inputSchema?.properties ?? {} },
      // The current effect, so an override takes hold without reconnecting.
      effect: info.effect,
      effectFor: () => policyEffect(this.current(server.id, info)),
      // Until the person says what this tool does, every call asks.
      mustAsk: () => (this.current(server.id, info).confirmed ? null : `${server.name} says ${info.name} ${info.hint === 'read' ? 'only looks' : 'changes things'}, but you haven’t set what it does yet`),
      label: (i) => `${server.name}: ${info.name}${summarize(i)}`,
      approval: (i) => {
        const effect = policyEffect(this.current(server.id, info));
        return { action: `Use ${info.name}`, target: server.name, preview: JSON.stringify(i, null, 2), risk: effect === 'read' || effect === 'write' ? 'medium' : 'high' };
      },
      run: async (input) => {
        const res = await withTimeout(client.callTool({ name: info.name, arguments: input as Record<string, unknown> }), CALL_TIMEOUT_MS, `${info.name} took too long`);
        const parts = (res.content as { type: string; text?: string; mimeType?: string }[] | undefined ?? [])
          .map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''}]`));
        const text = parts.join('\n').trim() || (res.structuredContent ? JSON.stringify(res.structuredContent) : '(no output)');
        if (res.isError) throw new Error(truncate(text, 2000));
        return truncate(text, MAX_RESULT);
      },
    };
  }

  /** The tool as saved now, so a change of effect takes hold without reconnecting. */
  private current(serverId: string, info: McpToolInfo): McpToolInfo {
    return this.store.db.get<McpServer>('mcp', serverId)?.tools.find((t) => t.name === info.name) ?? info;
  }

  private check(input: McpInput) {
    if (!input.name || typeof input.name !== 'string' || input.name.length > 40 || !/^[A-Za-z0-9][\w .-]*$/.test(input.name)) {
      throw badRequest('name must be up to 40 letters, digits, spaces, dots, dashes or underscores');
    }
    if (input.transport === 'stdio') {
      if (!input.command || typeof input.command !== 'string') throw badRequest('A stdio server needs a command, like "npx"');
      if (input.args && (!Array.isArray(input.args) || input.args.some((a) => typeof a !== 'string'))) throw badRequest('args must be a list of strings');
    } else if (input.transport === 'http') {
      try {
        if (!/^https?:$/.test(new URL(input.url ?? '').protocol)) throw new Error();
      } catch {
        throw badRequest('An http server needs its URL, like https://example.com/mcp');
      }
    } else {
      throw badRequest('transport must be stdio or http');
    }
    for (const field of ['env', 'headers'] as const) {
      const o = input[field];
      if (o !== undefined && (typeof o !== 'object' || o === null || Array.isArray(o) || Object.entries(o).some(([k, v]) => !/^[\w-]{1,100}$/.test(k) || typeof v !== 'string'))) {
        throw badRequest(`${field} must be an object of names to text values`);
      }
    }
    if (input.toolEffects !== undefined && (typeof input.toolEffects !== 'object' || Object.values(input.toolEffects).some((e) => !EFFECTS.includes(e)))) {
      throw badRequest(`toolEffects values must be one of ${EFFECTS.join(', ')}`);
    }
  }

  private private(id: string): McpPrivate {
    return this.store.db.getPrivate<McpPrivate>('mcp', id) ?? { env: {}, headers: {} };
  }

  private put(server: McpServer, priv?: McpPrivate): McpServer {
    if (priv) server = { ...server, envKeys: Object.keys(priv.env), headerKeys: Object.keys(priv.headers) };
    const saved = this.store.db.put<McpServer>('mcp', server);
    // After the row exists: private data lives on it.
    if (priv) this.store.db.setPrivate('mcp', server.id, priv);
    this.store.bus.emit({ type: 'mcp.updated', data: saved });
    return saved;
  }

  private status(id: string, status: McpServer['status'], error: string | null) {
    const s = this.store.db.get<McpServer>('mcp', id);
    if (s) this.put({ ...s, status, error, ...(status === 'ready' ? {} : { tools: s.tools }), updatedAt: iso() });
  }
}

const cleanName = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');

/** mcp_<server>_<tool>, within the 64 characters model APIs allow. `prefix` is already clean (see McpManager.prefix). */
export function toolName(prefix: string, tool: string): string {
  return `mcp_${cleanName(prefix).slice(0, 20)}_${cleanName(tool)}`.slice(0, 64);
}

/** Two tools of one server whose names clean up the same get _2, _3… */
function unique(name: string, used: Set<string>): string {
  let out = name;
  for (let n = 2; used.has(out); n++) out = `${name.slice(0, 64 - String(n).length - 1)}_${n}`;
  used.add(out);
  return out;
}

/** The person's choice when they made one, otherwise the server's hint. */
function effectOf(chosen: McpEffect | undefined, hint: McpEffect): { effect: McpEffect; confirmed: boolean } {
  return chosen ? { effect: chosen, confirmed: true } : { effect: hint, confirmed: false };
}

/** What the policy goes by: until the person confirms, a tool is never less than a write, since hints can lie (and mustAsk asks anyway). */
const policyEffect = (t: McpToolInfo): McpEffect => (t.confirmed || t.effect !== 'read' ? t.effect : 'write');

/** MCP's hints: read-only tools are reads, destructive ones deletes, the rest change things. */
function effectFromHints(a?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }): McpEffect {
  if (a?.readOnlyHint) return 'read';
  if (a?.destructiveHint) return 'delete';
  return 'write';
}

const summarize = (input: unknown) => {
  const first = input && typeof input === 'object' ? Object.values(input).find((v) => typeof v === 'string') : undefined;
  return typeof first === 'string' && first ? ` “${firstLine(first, 50)}”` : '';
};

const pick = <T extends object>(o: T, keys: string[]) =>
  Object.fromEntries(Object.entries(o).filter(([k, v]) => keys.includes(k) && v !== undefined)) as Partial<T>;

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}
