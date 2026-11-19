// An app-event trigger's settings: Composio gives each trigger type a JSON schema for its `config`; this turns the simple
// part of it into form fields and the typed fields back into the config object the API takes. Pure.

export type ConfigField = {
  key: string;
  label: string;
  description: string;
  /** `json` is the fallback for anything nested or unusual: a textarea holding JSON. */
  type: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json';
  required: boolean;
  options: string[];
  /** The schema's default as the form shows it: text for most, a boolean for a checkbox. */
  initial: string | boolean;
};
export type ConfigValues = Record<string, string | boolean>;

const asRecord = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const humanize = (key: string) => key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().replace(/^./, c => c.toUpperCase());

/** The fields of a trigger type's config schema, required ones first as the schema lists them; none for a schema without properties. */
export function configFields(schema: unknown): ConfigField[] {
  const root = asRecord(schema);
  const props = asRecord(root?.properties);
  if (!props) return [];
  const required = new Set(Array.isArray(root?.required) ? root.required.filter((k): k is string => typeof k === 'string') : []);
  const fields = Object.entries(props).map(([key, raw]): ConfigField => {
    const p = asRecord(raw) ?? {};
    const options = Array.isArray(p.enum) && p.enum.length && p.enum.every(o => typeof o === 'string') ? p.enum as string[] : [];
    const type: ConfigField['type'] = options.length ? 'enum'
      : p.type === 'string' || p.type === 'number' || p.type === 'integer' || p.type === 'boolean' ? p.type : 'json';
    const d = p.default;
    const initial: string | boolean = d === undefined || d === null ? (type === 'boolean' ? false : '')
      : type === 'boolean' ? d === true : type === 'json' ? JSON.stringify(d, null, 2) : String(d);
    return {
      key, label: typeof p.title === 'string' && p.title ? p.title : humanize(key), description: typeof p.description === 'string' ? p.description : '',
      type, required: required.has(key), options, initial,
    };
  });
  return [...fields.filter(f => f.required), ...fields.filter(f => !f.required)];
}

/** The form's starting values: each field's default. */
export const configInitial = (fields: readonly ConfigField[]): ConfigValues => Object.fromEntries(fields.map(f => [f.key, f.initial]));

/**
 * The config the values describe, and what is wrong with them: a required field left empty, a number that is not one, JSON
 * that does not parse. An optional field left empty is left out; an unchecked box is sent as false only when required.
 */
export function configValue(fields: readonly ConfigField[], values: ConfigValues): {config: Record<string, unknown>; problems: string[]} {
  const config: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const f of fields) {
    const v = values[f.key] ?? f.initial;
    if (f.type === 'boolean') {
      if (v === true || f.required) config[f.key] = v === true;
      continue;
    }
    const text = typeof v === 'string' ? v.trim() : '';
    if (!text) {
      if (f.required) problems.push(`${f.label} is required`);
      continue;
    }
    if (f.type === 'number' || f.type === 'integer') {
      const n = Number(text);
      if (!Number.isFinite(n) || (f.type === 'integer' && !Number.isInteger(n))) problems.push(`${f.label} must be ${f.type === 'integer' ? 'a whole number' : 'a number'}`);
      else config[f.key] = n;
    } else if (f.type === 'json') {
      try { config[f.key] = JSON.parse(text); } catch { problems.push(`${f.label} must be valid JSON`); }
    } else config[f.key] = text;
  }
  return {config, problems};
}

/** A trigger type's name as a row shows it, without the app's prefix: `GITHUB_COMMIT_EVENT` of `github` reads `Commit event`. */
export function appEventName(app: string, slug: string): string {
  const prefix = `${app}_`.toLowerCase();
  const rest = slug.toLowerCase().startsWith(prefix) ? slug.slice(prefix.length) : slug;
  return humanize(rest.toLowerCase());
}
