import type { Correction } from '../learning.ts';
import type { Config } from '../../config.ts';
import type { Providers } from '../../connections/providers.ts';
import type { Store } from '../../store.ts';
import type { CreateTaskInput, MessageCard, Risk, Star, Task, TaskCommand } from '../../types.ts';
import type { BrowserManager } from '../../browser/browser.ts';
import type { ClientToolSpec } from '../brain.ts';

/**
 * What a tool does to the world. The policy engine decides from this (plus
 * autonomy, rules and connection access) whether a call needs an approval.
 *  - internal: a Star's own bookkeeping (memory, progress, tasks, talking to other Stars)
 *  - read: looks, never changes anything
 *  - write: changes something that can be undone (a draft, a label, a page edit)
 *  - send: reaches other people (email, invites, posts)
 *  - delete / spend: can't be undone or costs money
 */
export type Effect = 'internal' | 'read' | 'write' | 'send' | 'delete' | 'spend';

/** The parts of the runtime a tool may call back into. */
export interface RuntimeHooks {
  /** `input.starId` picks the Star that owns it (the main Star by default). */
  createTask(input: CreateTaskInput, origin: string, requestedBy?: Task['requestedBy']): Task;
  commandTask(id: string, command: TaskCommand): Task;
  /** Posts to the Star's own chat (the main chat for the main Star) and the person's channels. */
  notify(message: string, opts: { urgent?: boolean; taskId?: string; cards?: MessageCard[]; starId?: string; kind?: 'needs_you' }): Promise<string>;
  /** A task another Star asked for has ended: answer the Star that asked, and wake its task if it was waiting. */
  starAnswered(task: Task, answer: string, failed: boolean): void;
  /** A task has ended: stop the ask_star requests it still had open with other Stars. */
  dropAsks(taskId: string, reason: string): void;
  /** Learns from a correction in the background (see learning.ts); `fallback` runs if no lesson came of it. */
  learn(starId: string, c: Correction, fallback?: () => void): void;
  /** A run ended. `reported` is true when the Star itself called finish_task (so a failure is worth learning from). */
  taskEnded(task: Task, outcome: string, failed: boolean, reported: boolean): void;
  /** When a recurring or watch task should next run. */
  nextRunAt(task: Task, after: Date): string | undefined;
}

export interface ToolContext {
  store: Store;
  config: Config;
  providers: Providers;
  runtime: RuntimeHooks;
  /** The Star doing the work. */
  star: Star;
  browser?: BrowserManager;
  /** Set when running inside a task. */
  task?: Task;
  /** Set when replying in a chat. */
  conversationId?: string;
  /** Where a memory came from, e.g. "Chat on Oct 2". */
  source: string;
  /** Tasks this call created or touched, for linking chat replies. */
  touchedTasks: Set<string>;
}

/** What the person sees on an approval card. */
export interface ApprovalPreview {
  action: string;
  target: string;
  preview: string;
  risk?: Risk;
}

export interface ToolResult {
  /** Returned to the model. */
  content: string;
  /** One line for the task timeline; defaults to the tool's label. */
  summary?: string;
}

/** What a tool may look at when judging a call before it runs (the browser tools look up the element). */
export interface ToolEnv {
  starId: string;
  browser?: BrowserManager;
}

export interface ToolDef<I = any> extends ClientToolSpec {
  effect: Effect;
  /** When the effect depends on the input (an event with guests sends invites, one without doesn't). */
  effectFor?(input: I, env?: ToolEnv): Effect;
  /** Connection id this tool works through, if any. */
  connection?: string;
  /** Only offered in chat, or only inside tasks. */
  scope?: 'chat' | 'task';
  /** One line for the timeline before the result is known. */
  label(input: I): string;
  /** How a gated call is shown for approval. Required for send, delete and spend tools. */
  approval?(input: I, env?: ToolEnv): ApprovalPreview;
  /** Applies "approve with my edits": the edited preview back onto the input. */
  applyEdit?(input: I, editedPreview: string): I;
  run(input: I, ctx: ToolContext): Promise<ToolResult | string>;
}

/** Light validation of model-supplied input against the tool's schema. */
export function validateInput(tool: ClientToolSpec, input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  const obj = input as Record<string, unknown>;
  for (const key of tool.input_schema.required ?? []) {
    if (obj[key] === undefined || obj[key] === null || obj[key] === '') return `missing required field "${key}"`;
  }
  for (const [key, value] of Object.entries(obj)) {
    const prop = tool.input_schema.properties[key] as { type?: string; enum?: unknown[] } | undefined;
    if (!prop || value === undefined || value === null) continue;
    const t = prop.type;
    const ok = t === 'array' ? Array.isArray(value) : t === 'integer' ? Number.isInteger(value) : !t || typeof value === t;
    if (!ok) return `"${key}" must be ${t}`;
    if (prop.enum && !prop.enum.includes(value)) return `"${key}" must be one of ${prop.enum.join(', ')}`;
  }
  return null;
}

export const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
export const num = (description: string) => ({ type: 'number', description });
export const bool = (description: string) => ({ type: 'boolean', description });
export const schema = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object' as const, properties, required });
