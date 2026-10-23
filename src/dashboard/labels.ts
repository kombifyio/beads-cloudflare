/** Display names for catalog groups and roadmap phases. Labels are presentation only and never grant access. */
export type Label = string | Record<string, string>;
export interface PortfolioLabels { groups: Record<string, Label>; phases: Record<string, Label> }

const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const LANGUAGE = /^[a-z]{2}(-[A-Za-z0-9]{1,8})?$/;
const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 80;

function table(value: unknown, field: string): Record<string, Label> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid portfolio labels: ${field}`);
  const out: Record<string, Label> = {};
  for (const [key, label] of Object.entries(value)) {
    if (!KEY.test(key)) throw new Error(`invalid portfolio labels: ${field} key`);
    if (text(label)) { out[key] = label as string; continue; }
    if (!label || typeof label !== 'object' || Array.isArray(label)) throw new Error(`invalid portfolio labels: ${field}.${key}`);
    const entries = Object.entries(label);
    if (!entries.length || entries.some(([lang, name]) => !LANGUAGE.test(lang) || !text(name))) throw new Error(`invalid portfolio labels: ${field}.${key}`);
    out[key] = Object.fromEntries(entries) as Record<string, string>;
  }
  return out;
}

/** `PORTFOLIO_LABELS` is `{groups?, phases?}`; each maps a key to a name or to names per language. Empty: raw keys. */
export function portfolioLabels(env: Env): PortfolioLabels {
  const raw: unknown = env.PORTFOLIO_LABELS ? JSON.parse(env.PORTFOLIO_LABELS) : {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid portfolio labels');
  const { groups, phases, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length) throw new Error('invalid portfolio labels: unknown field');
  return { groups: table(groups, 'groups'), phases: table(phases, 'phases') };
}
