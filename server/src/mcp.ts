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
 * Every MCP tool gets an effect (read, write, send, delete, spend) from the
 * server's own hints, which the person can override per tool, so the policy
 * still decides what needs an approval. Stars only see the servers they're
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
    const saved = this.put({ ...next, tools: next.tools.map((t) => ({ ...t, effect: next.toolEffects[t.name] ?? t.effect })) },
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
      const infos: McpToolInfo[] = listed.tools.map((t) => ({
        name: t.name, toolName: toolName(server.name, t.name), description: firstLine(t.description ?? '', 300),
        effect: server.toolEffects[t.name] ?? effectFromHints(t.annotations),
      }));
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
      this.status(id, 'error', err instanceof Error ? err.message : String(err));
    }
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
      effectFor: () => this.store.db.get<McpServer>('mcp', server.id)?.tools.find((t) => t.name === info.name)?.effect ?? info.effect,
      label: (i) => `${server.name}: ${info.name}${summarize(i)}`,
      approval: (i) => ({ action: `Use ${info.name}`, target: server.name, preview: JSON.stringify(i, null, 2), risk: info.effect === 'read' || info.effect === 'write' ? 'medium' : 'high' }),
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

/** mcp_<server>_<tool>, within the 64 characters model APIs allow. */
export function toolName(server: string, tool: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return `mcp_${clean(server).slice(0, 20)}_${clean(tool)}`.slice(0, 64);
}

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
