/** Display names for catalog groups and roadmap phases, and the label conventions a deployment's trackers follow. Labels are presentation only and never grant access. */
export type Label = string | Record<string, string>;
/** Which tracker labels carry meaning. Neutral defaults: no repository labels, `milestone` epics, `phase:<key>` phases, `blocked-*` waiting labels. */
export interface Conventions { repoPrefix: string; milestoneLabel: string; phasePrefix: string; waiting: string[] }
export interface PortfolioLabels { groups: Record<string, Label>; phases: Record<string, Label>; conventions: Conventions }

export const NEUTRAL_CONVENTIONS: Conventions = { repoPrefix: '', milestoneLabel: 'milestone', phasePrefix: 'phase:', waiting: ['blocked-*'] };
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const PREFIX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,30}[:/=]$/;
const PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,62}\*?$/;
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

function conventions(value: unknown): Conventions {
  if (value === undefined) return { ...NEUTRAL_CONVENTIONS, waiting: [...NEUTRAL_CONVENTIONS.waiting] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid portfolio labels: conventions');
  const { repo_prefix, milestone_label, phase_prefix, waiting_labels, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length) throw new Error('invalid portfolio labels: conventions field');
  // An empty repository prefix turns repository labels off; the other conventions always name a label.
  if (repo_prefix !== undefined && repo_prefix !== '' && !(typeof repo_prefix === 'string' && PREFIX.test(repo_prefix))) throw new Error('invalid portfolio labels: conventions.repo_prefix');
  if (milestone_label !== undefined && !(typeof milestone_label === 'string' && KEY.test(milestone_label))) throw new Error('invalid portfolio labels: conventions.milestone_label');
  if (phase_prefix !== undefined && !(typeof phase_prefix === 'string' && PREFIX.test(phase_prefix))) throw new Error('invalid portfolio labels: conventions.phase_prefix');
  if (waiting_labels !== undefined && !(Array.isArray(waiting_labels) && waiting_labels.length <= 32 && waiting_labels.every(p => typeof p === 'string' && PATTERN.test(p)))) throw new Error('invalid portfolio labels: conventions.waiting_labels');
  return {
    repoPrefix: (repo_prefix as string | undefined) ?? NEUTRAL_CONVENTIONS.repoPrefix,
    milestoneLabel: (milestone_label as string | undefined) ?? NEUTRAL_CONVENTIONS.milestoneLabel,
    phasePrefix: (phase_prefix as string | undefined) ?? NEUTRAL_CONVENTIONS.phasePrefix,
    waiting: [...((waiting_labels as string[] | undefined) ?? NEUTRAL_CONVENTIONS.waiting)],
  };
}

/** `PORTFOLIO_LABELS` is `{groups?, phases?, conventions?}`; names map a key to a name or to names per language. Empty: raw keys and neutral conventions. */
export function portfolioLabels(env: Env): PortfolioLabels {
  const raw: unknown = env.PORTFOLIO_LABELS ? JSON.parse(env.PORTFOLIO_LABELS) : {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid portfolio labels');
  const { groups, phases, conventions: rules, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length) throw new Error('invalid portfolio labels: unknown field');
  return { groups: table(groups, 'groups'), phases: table(phases, 'phases'), conventions: conventions(rules) };
}

/** A waiting label matches a pattern exactly, or a `prefix*` pattern with at least one more character. */
export const waitingLabel = (c: Conventions, labels: readonly string[]) =>
  labels.find(label => c.waiting.some(p => p.endsWith('*') ? label.length >= p.length && label.startsWith(p.slice(0, -1)) : label === p)) ?? null;
/** The repository a `<repo_prefix><owner>/<name>` or `<repo_prefix><name>` label names, or null when the convention is off. */
export const repoLabel = (c: Conventions, labels: readonly string[]) => {
  if (!c.repoPrefix) return null;
  const label = labels.find(l => l.startsWith(c.repoPrefix) && l.length > c.repoPrefix.length);
  return label ? label.slice(c.repoPrefix.length).split('/').pop() || null : null;
};
export const isMilestone = (c: Conventions, item: { issue_type?: string; labels?: string[] }) =>
  item.issue_type === 'milestone' || (item.issue_type === 'epic' && (item.labels ?? []).includes(c.milestoneLabel));
export const phaseOf = (c: Conventions, labels: readonly string[]) => {
  const label = labels.find(l => l.startsWith(c.phasePrefix) && KEY.test(l.slice(c.phasePrefix.length)));
  return label ? label.slice(c.phasePrefix.length) : null;
};
/** Phases follow the order their names are configured in, then natural order; no phase comes last. */
export function phaseCompare(phases: Record<string, Label>) {
  const order = Object.keys(phases);
  const rank = (p: string | null) => !p ? Infinity : order.includes(p) ? order.indexOf(p) : order.length;
  return (a: string | null, b: string | null) => (rank(a) - rank(b) || 0) || String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true });
}
