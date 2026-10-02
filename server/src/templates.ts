import type { Providers } from './connections/providers.ts';
import type { Store } from './store.ts';
import type { AvatarCharacter, AvatarColor, Autonomy, Star, StarTemplate, TemplateEntry } from './types.ts';
import { ApiError, badRequest } from './util.ts';

const CHARACTERS: AvatarCharacter[] = ['cloud', 'dot', 'drop'];
const COLORS: AvatarColor[] = ['sky', 'peach', 'mint', 'lilac', 'sun'];
const AUTONOMY: Autonomy[] = ['ask', 'balanced', 'autonomous'];
const GALLERY_TTL_MS = 30 * 60_000;
const MAX_TEMPLATE_BYTES = 200_000;

/** Starter Stars that ship with Sky. */
const BUILT_IN: StarTemplate[] = [
  {
    format: 'sky.star', version: 1, name: 'Scout', role: 'Researches anything and compares the options',
    description: 'Looks things up, reads the pages, and comes back with a short comparison and a pick.',
    instructions: 'Check at least three sources. Lead with your pick and why, then a short comparison. Link what you used.',
    personality: 'Curious and to the point', replyStyle: 'A one-line answer, then bullet points',
    avatar: { character: 'dot', color: 'mint' }, autonomy: null, apps: ['web', 'browser'],
    skills: [{ name: 'Compare options', whenToUse: 'The person wants the best of several choices', steps: '1. List the options and what matters to the person (check memory)\n2. Look each one up\n3. Compare in a short table or bullets\n4. Say which you’d pick and why' }],
    rules: [],
  },
  {
    format: 'sky.star', version: 1, name: 'Inbox', role: 'Keeps your email under control',
    description: 'Sorts new mail, drafts replies for you to approve, and tells you what needs you.',
    instructions: 'Never send without asking. Draft replies in the person’s voice (check memory for their style). Summaries are three lines at most.',
    personality: 'Calm and tidy', replyStyle: 'Short. Who, what, and what you need from them',
    avatar: { character: 'drop', color: 'sky' }, autonomy: 'ask', apps: ['gmail', 'calendar'],
    skills: [{ name: 'Morning inbox sweep', whenToUse: 'A daily look at new email', steps: '1. Search for unread mail from the last day\n2. Skip newsletters and receipts\n3. For each one that needs the person, one line on what and by when\n4. Offer drafts for the replies' }],
    rules: ['Always ask before sending an email'],
  },
  {
    format: 'sky.star', version: 1, name: 'Builder', role: 'Watches your GitHub and keeps work moving',
    description: 'Follows issues, pull requests and reviews, and nudges you about what’s waiting.',
    instructions: 'Focus on what’s blocked on the person. Link every issue or pull request you mention.',
    personality: 'Practical, a little dry', replyStyle: 'Bullet points with links',
    avatar: { character: 'cloud', color: 'lilac' }, autonomy: null, apps: ['github'],
    skills: [{ name: 'Review queue', whenToUse: 'Checking what’s waiting for the person on GitHub', steps: '1. Check notifications and review requests\n2. Group by repository\n3. Say which ones are oldest or blocking others' }],
    rules: [],
  },
];

/**
 * Sharing Stars. A template is a Star's role, instructions, style, skills,
 * rules and which apps it uses: never its memory, chats or secrets. The
 * gallery is free: a public GitHub repository with an index.json listing
 * template files (or any https URL serving one).
 */
export class Templates {
  store: Store;
  providers: Providers;
  private cache: { at: number; key: string; entries: TemplateEntry[]; error: string | null } | null = null;

  constructor(store: Store, providers: Providers) {
    this.store = store;
    this.providers = providers;
  }

  /** A Star as a template. */
  export(starId: string): StarTemplate {
    const star = this.store.getStar(starId);
    return {
      format: 'sky.star', version: 1, name: star.name, role: star.role, instructions: star.instructions,
      personality: star.personality, replyStyle: star.replyStyle, avatar: star.avatar, autonomy: star.autonomy, apps: star.connectionIds,
      skills: this.store.listSkills(star.id).filter((k) => k.starId === star.id).map((k) => ({ name: k.name, whenToUse: k.whenToUse, steps: k.steps })),
      rules: this.store.listRules(star.id).filter((r) => r.starId === star.id && !r.builtIn).map((r) => r.text),
    };
  }

  /** Built-in templates plus the gallery's. */
  async list(): Promise<{ templates: TemplateEntry[]; galleryError: string | null }> {
    const builtIn = BUILT_IN.map((t) => ({ id: `builtin:${t.name.toLowerCase()}`, source: 'builtIn' as const, template: t }));
    const gallery = await this.gallery();
    return { templates: [...builtIn, ...gallery.entries], galleryError: gallery.error };
  }

  private async gallery(): Promise<{ entries: TemplateEntry[]; error: string | null }> {
    const where = this.store.settings().templateGallery?.trim();
    if (!where) return { entries: [], error: null };
    if (this.cache && this.cache.key === where && Date.now() - this.cache.at < GALLERY_TTL_MS) return this.cache;
    const index = galleryIndexUrl(where);
    let entries: TemplateEntry[] = [];
    let error: string | null = null;
    try {
      const list = await this.fetchJson(index) as { templates?: (string | { url: string })[] } | (string | { url: string })[];
      const urls = (Array.isArray(list) ? list : list.templates ?? []).map((x) => new URL(typeof x === 'string' ? x : x.url, index).toString()).slice(0, 50);
      const results = await Promise.allSettled(urls.map(async (url) => ({ url, template: validate(await this.fetchJson(url)) })));
      entries = results.flatMap((r, i) => (r.status === 'fulfilled' ? [{ id: `gallery:${i}:${r.value.template.name.toLowerCase()}`, source: 'gallery' as const, template: r.value.template, url: r.value.url }] : []));
      const bad = results.filter((r) => r.status === 'rejected').length;
      if (bad) error = `${bad} template${bad === 1 ? '' : 's'} in the gallery couldn’t be read`;
    } catch (err) {
      error = `Couldn’t read the gallery: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.cache = { at: Date.now(), key: where, entries, error };
    return this.cache;
  }

  private async fetchJson(url: string): Promise<unknown> {
    if (!/^https:\/\//.test(url)) throw new Error('Templates are only read over https');
    const res = await this.providers.fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_TEMPLATE_BYTES) throw new Error('That file is too large to be a template');
    return JSON.parse(text);
  }

  /** Makes a new Star from a template (given directly, by gallery id, or by https URL). */
  async import(input: { template?: unknown; id?: string; url?: string }, create: (s: Pick<Star, 'name' | 'role' | 'instructions' | 'avatar' | 'autonomy' | 'connectionIds' | 'providerIds' | 'personality' | 'replyStyle' | 'notify' | 'mcpServerIds'>) => Star):
    Promise<{ star: Star; skipped: string[] }> {
    let t: StarTemplate;
    if (input.template !== undefined) t = validate(input.template);
    else if (input.id) {
      const hit = (await this.list()).templates.find((e) => e.id === input.id);
      if (!hit) throw new ApiError(404, 'not_found', `No template ${input.id}`);
      t = hit.template;
    } else if (input.url) {
      try {
        t = validate(await this.fetchJson(input.url));
      } catch (err) {
        throw err instanceof ApiError ? err : badRequest(`Couldn’t read that template: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else throw badRequest('Send a template, a template id, or an https url');

    const skipped: string[] = [];
    const known = this.store.listConnections().map((c) => c.id);
    const apps = t.apps === null ? null : t.apps.filter((a) => known.includes(a) || (skipped.push(`app ${a} (not available here)`), false));
    let name = t.name;
    for (let n = 2; this.store.findStar(name); n++) name = `${t.name} ${n}`;
    const star = create({
      name, role: t.role, instructions: t.instructions, avatar: t.avatar, autonomy: t.autonomy, connectionIds: apps, providerIds: null,
      personality: t.personality, replyStyle: t.replyStyle, notify: { whenDone: false, whenNeedsYou: true }, mcpServerIds: null,
    });
    for (const k of t.skills) {
      let skillName = k.name;
      if (this.store.findSkill(skillName)) skillName = `${k.name} (${name})`;
      try {
        this.store.addSkill({ name: skillName, whenToUse: k.whenToUse, steps: k.steps, starId: star.id, source: 'you' });
      } catch {
        skipped.push(`skill ${k.name} (name taken)`);
      }
    }
    for (const r of t.rules) this.store.addRule(r, star.id);
    this.store.log('message', `New Star from a template: ${star.name}`, undefined, star.id);
    return { star: this.store.getStar(star.id), skipped };
  }
}

/** "owner/repo" means index.json at the top of that public GitHub repository. */
export function galleryIndexUrl(where: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(where)) return `https://raw.githubusercontent.com/${where}/HEAD/index.json`;
  return where;
}

/** Checks a template strictly: it comes from outside and becomes a Star's instructions. */
export function validate(v: unknown): StarTemplate {
  const t = v as Record<string, any>;
  if (!t || typeof t !== 'object' || t.format !== 'sky.star' || t.version !== 1) throw badRequest('Not a Sky Star template (format "sky.star", version 1)');
  const str = (x: unknown, field: string, max: number, required = false) => {
    if (x === undefined || x === null) {
      if (required) throw badRequest(`template.${field} is required`);
      return '';
    }
    if (typeof x !== 'string' || x.length > max) throw badRequest(`template.${field} must be text up to ${max} characters`);
    return x.trim();
  };
  const name = str(t.name, 'name', 40, true);
  if (!name) throw badRequest('template.name is required');
  const avatar = t.avatar && CHARACTERS.includes(t.avatar.character) && COLORS.includes(t.avatar.color)
    ? { character: t.avatar.character as AvatarCharacter, color: t.avatar.color as AvatarColor }
    : { character: 'dot' as const, color: 'mint' as const };
  if (t.apps !== undefined && t.apps !== null && (!Array.isArray(t.apps) || t.apps.some((a: unknown) => typeof a !== 'string'))) throw badRequest('template.apps must be a list of app ids, or null');
  if (t.skills !== undefined && (!Array.isArray(t.skills) || t.skills.length > 30)) throw badRequest('template.skills must be a list of up to 30 skills');
  if (t.rules !== undefined && (!Array.isArray(t.rules) || t.rules.length > 30 || t.rules.some((r: unknown) => typeof r !== 'string' || r.length > 500))) {
    throw badRequest('template.rules must be a list of up to 30 rules');
  }
  return {
    format: 'sky.star', version: 1, name, role: str(t.role, 'role', 200, true) || 'A Star', description: str(t.description, 'description', 500),
    instructions: str(t.instructions, 'instructions', 4000), personality: str(t.personality, 'personality', 1000), replyStyle: str(t.replyStyle, 'replyStyle', 1000),
    avatar, autonomy: AUTONOMY.includes(t.autonomy) ? t.autonomy : null, apps: t.apps ?? null,
    skills: (t.skills ?? []).map((k: Record<string, unknown>, i: number) => ({
      name: str(k?.name, `skills[${i}].name`, 80, true), whenToUse: str(k?.whenToUse, `skills[${i}].whenToUse`, 300, true), steps: str(k?.steps, `skills[${i}].steps`, 8000, true),
    })),
    rules: (t.rules ?? []).map((r: string) => r.trim()).filter(Boolean),
  };
}

export const templateFileName = (t: StarTemplate) => `${t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'star'}.sky-star.json`;
