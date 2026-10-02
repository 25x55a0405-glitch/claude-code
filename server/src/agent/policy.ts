import type { Store } from '../store.ts';
import type { Risk, Rule } from '../types.ts';
import type { Brain } from './brain.ts';
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

  constructor(store: Store, brain: Brain) {
    this.store = store;
    this.brain = brain;
  }

  async check(tool: ToolDef, input: unknown, why: string): Promise<Verdict> {
    const effect = tool.effectFor?.(input) ?? tool.effect;
    if (effect === 'internal' || effect === 'read') return { kind: 'allow' };
    const preview: ApprovalPreview = tool.approval?.(input) ?? { action: tool.label(input), target: tool.connection ?? 'Skys', preview: JSON.stringify(input, null, 2) };
    const text = `${preview.action} ${preview.target} ${preview.preview}`;

    if (tool.connection) {
      const conn = this.store.getConnection(tool.connection);
      if (conn.access === 'read') {
        return { kind: 'forbid', reason: `${conn.name} is set to read-only, so Skys can’t ${preview.action.toLowerCase()} there. The person can allow it on the Connections screen.` };
      }
    }
    const rules = this.store.listRules().filter((r) => r.enabled);
    if (rules.some((r) => r.id === 'r_pw') && SECURITY.test(text)) {
      return { kind: 'forbid', reason: 'Built-in rule: Skys never changes passwords or security settings.' };
    }
    if (effect === 'spend' || (effect !== 'write' && MONEY.test(`${preview.action} ${preview.preview}`))) {
      return { kind: 'ask', reason: 'Built-in rule: always ask before spending money or moving funds.', risk: 'high' };
    }

    const custom = rules.filter((r) => !r.builtIn);
    const ruling = custom.length ? await this.applyRules(custom, preview, why) : null;
    if (ruling?.verdict === 'forbid') return { kind: 'forbid', reason: `Your rule: “${ruling.rule}”` };
    if (ruling?.verdict === 'ask') return { kind: 'ask', reason: `${why} (your rule: “${ruling.rule}”)`, risk: preview.risk ?? RISK[effect] };
    if (ruling?.verdict === 'allow' && effect !== 'delete') return { kind: 'allow' };

    const autonomy = this.store.settings().autonomy;
    const needsOk = autonomy === 'ask' || (autonomy === 'balanced' && effect !== 'write') || (autonomy === 'autonomous' && effect === 'delete');
    return needsOk ? { kind: 'ask', reason: why, risk: preview.risk ?? RISK[effect] } : { kind: 'allow' };
  }

  /** Asks the model which of the person's rules, if any, governs this action. */
  private async applyRules(rules: Rule[], p: ApprovalPreview, why: string): Promise<{ verdict: 'allow' | 'ask' | 'forbid'; rule: string } | null> {
    const list = rules.map((r, i) => `${i + 1}. ${r.text}`).join('\n');
    const prompt = `Rules the person set for their assistant:\n${list}\n\nThe assistant wants to: ${p.action}\nTarget: ${p.target}\nWhy: ${why}\nContent:\n${p.preview.slice(0, 2000)}\n\n`
      + 'Does any rule directly govern this exact action? Answer with one line: "<rule number> allow", "<rule number> ask", "<rule number> forbid", or "none". '
      + '"allow" means a rule explicitly permits doing this without asking; "ask" means a rule requires asking first; "forbid" means a rule says never do it.';
    try {
      const answer = (await this.brain.complete('You check actions against rules. Reply with exactly one line.', prompt, 50)).toLowerCase();
      const m = /(\d+)\s+(allow|ask|forbid)/.exec(answer);
      if (!m) return null;
      const rule = rules[Number(m[1]) - 1];
      return rule ? { verdict: m[2] as 'allow' | 'ask' | 'forbid', rule: rule.text } : null;
    } catch {
      // If the rule check can't run, fall back to asking.
      return { verdict: 'ask', rule: 'Couldn’t check your rules, so asking to be safe' };
    }
  }
}
