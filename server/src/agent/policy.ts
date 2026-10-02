import type { Store } from '../store.ts';
import type { Risk, Rule, Star } from '../types.ts';
import type { Brain } from './brain.ts';
import type { BrowserManager } from '../browser/browser.ts';
import type { Vault } from '../vault.ts';
import type { Workspaces } from '../workspace.ts';
import type { ApprovalPreview, Effect, ToolDef } from './tools/types.ts';

export type Verdict =
  | { kind: 'allow' }
  | { kind: 'ask'; reason: string; risk: Risk }
  | { kind: 'forbid'; reason: string };

const SECURITY = /\b(password|passcode|2fa|two[- ]factor|mfa|security settings?|recovery (code|email)|api key|secret key)\b/i;
const MONEY = /\b(pay|payment|purchase|buy|checkout|transfer|wire|invoice|refund|subscribe|\$\s?\d|usd|eur|gbp|inr)\b/i;
const RISK: Record<Effect, Risk> = { internal: 'low', read: 'low', write: 'low', send: 'medium', delete: 'high', spend: 'high' };

/**
 * Decides whether an action may run on its own, needs the person's OK, or
 * must not happen at all. Order matters:
 *   1. read-only connections refuse anything that changes things
 *   2. built-in rules: money always asks, password and security changes never run
 *   3. the person's own plain-language rules (checked by the model)
 *   4. the autonomy level
 */
export class Policy {
  store: Store;
  brain: Brain;
  browser?: BrowserManager;
  vault?: Vault;
  workspaces?: Workspaces;

  constructor(store: Store, brain: Brain) {
    this.store = store;
    this.brain = brain;
  }

  /** Decides for one Star: its own autonomy (or the global one) and the global rules plus its own. */
  async check(tool: ToolDef, input: unknown, why: string, star: Star = this.store.mainStar()): Promise<Verdict> {
    const env = { starId: star.id, browser: this.browser, workspaces: this.workspaces, vault: this.vault };
    const effect = tool.effectFor?.(input, env) ?? tool.effect;
    // A secret leaving through any tool needs the person's OK, whatever the autonomy.
    const secrets = this.vault?.refs(input) ?? [];
    if (secrets.length && effect !== 'internal') {
      return { kind: 'ask', reason: `${why} (uses your secret ${secrets.join(', ')})`, risk: 'high' };
    }
    if (effect === 'internal' || effect === 'read') return { kind: 'allow' };
    const preview: ApprovalPreview = tool.approval?.(input, env) ?? { action: tool.label(input), target: tool.connection ?? star.name, preview: JSON.stringify(input, null, 2) };
    const text = `${preview.action} ${preview.target} ${preview.preview}`;

    if (tool.connection) {
      const conn = this.store.getConnection(tool.connection);
      if (conn.access === 'read') {
        return { kind: 'forbid', reason: `${conn.name} is set to read-only, so ${star.name} can’t ${preview.action.toLowerCase()} there. The person can allow it on the Connections screen.` };
      }
    }
    const rules = this.store.listRules(star.id).filter((r) => r.enabled);
    // Signing in with a saved login is the one password action allowed, and only once the person turned password fill on
    // (the tool isn't offered otherwise). It never changes a password: it refuses pages with a new-password field.
    if (rules.some((r) => r.id === 'r_pw') && SECURITY.test(text) && tool.name !== 'browser_fill_login') {
      return { kind: 'forbid', reason: 'Built-in rule: Stars never change passwords or security settings.' };
    }
    if (effect === 'spend' || (effect !== 'write' && MONEY.test(`${preview.action} ${preview.preview}`))) {
      return { kind: 'ask', reason: 'Built-in rule: always ask before spending money or moving funds.', risk: 'high' };
    }

    const must = tool.mustAsk?.(input, env);
    if (must) return { kind: 'ask', reason: `${why} (${must})`, risk: preview.risk ?? 'high' };

    const custom = rules.filter((r) => !r.builtIn);
    const ruling = custom.length ? await this.applyRules(custom, preview, why) : null;
    if (ruling?.verdict === 'forbid') return { kind: 'forbid', reason: `Your rule: “${ruling.rule}”` };
    if (ruling?.verdict === 'ask') return { kind: 'ask', reason: `${why} (your rule: “${ruling.rule}”)`, risk: preview.risk ?? RISK[effect] };
    // A rule that came with a template can't let a Star skip asking.
    if (ruling?.verdict === 'allow' && effect !== 'delete' && !ruling.askOnly) return { kind: 'allow' };

    const autonomy = star.autonomy ?? this.store.settings().autonomy;
    const needsOk = autonomy === 'ask' || (autonomy === 'balanced' && effect !== 'write') || (autonomy === 'autonomous' && effect === 'delete');
    return needsOk ? { kind: 'ask', reason: why, risk: preview.risk ?? RISK[effect] } : { kind: 'allow' };
  }

  /** Asks the model which of the person's rules, if any, governs this action. */
  private async applyRules(rules: Rule[], p: ApprovalPreview, why: string): Promise<{ verdict: 'allow' | 'ask' | 'forbid'; rule: string; askOnly?: boolean } | null> {
    const list = rules.map((r, i) => `${i + 1}. ${r.text}`).join('\n');
    const prompt = `Rules the person set for their assistant:\n${list}\n\nThe assistant wants to: ${p.action}\nTarget: ${p.target}\nWhy: ${why}\nContent:\n${p.preview.slice(0, 2000)}\n\n`
      + 'Does any rule directly govern this exact action? Answer with one line: "<rule number> allow", "<rule number> ask", "<rule number> forbid", or "none". '
      + '"allow" means a rule explicitly permits doing this without asking; "ask" means a rule requires asking first; "forbid" means a rule says never do it.';
    try {
      const answer = (await this.brain.complete('You check actions against rules. Reply with exactly one line.', prompt, 50)).toLowerCase();
      const m = /(\d+)\s+(allow|ask|forbid)/.exec(answer);
      if (!m) return null;
      const rule = rules[Number(m[1]) - 1];
      return rule ? { verdict: m[2] as 'allow' | 'ask' | 'forbid', rule: rule.text, askOnly: rule.askOnly } : null;
    } catch {
      // If the rule check can't run, fall back to asking.
      return { verdict: 'ask', rule: 'Couldn’t check your rules, so asking to be safe' };
    }
  }
}
