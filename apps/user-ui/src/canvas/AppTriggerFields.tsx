// The App event kind's fields in the schedule popover: one of the person's connected apps, then a trigger type Composio
// offers for it, then that type's settings. Presentational: the popover owns the state and the loading.
import type {AppTriggerType} from '@nest/schemas';
import {configFields,type ConfigValues} from './trigger-config';

export type AppTriggerFieldsProps = {
  /** The person's connected app slugs; null while loading. */
  apps: readonly string[] | null;
  app: string;
  /** The app's trigger types; null until they are read. */
  types: readonly AppTriggerType[] | null;
  typesError: string | null;
  slug: string;
  values: ConfigValues;
  disabled?: boolean;
  onApp(app: string): void;
  onSlug(slug: string): void;
  onValues(values: ConfigValues): void;
};

export function AppTriggerFields({apps, app, types, typesError, slug, values, disabled = false, onApp, onSlug, onValues}: AppTriggerFieldsProps) {
  const type = types?.find(t => t.slug === slug);
  const fields = type ? configFields(type.config) : [];
  const set = (key: string, value: string | boolean) => onValues({...values, [key]: value});
  if (apps === null) return <span className="calm" role="status">Loading your apps…</span>;
  if (!apps.length) return <span className="calm">Connect an app first (Integrations), then its events can start this.</span>;
  return <div className="sched-app">
    <select className="iv-in" aria-label="App" value={app} disabled={disabled} onChange={event => onApp(event.target.value)}>
      <option value="">Choose an app</option>
      {apps.map(a => <option key={a} value={a}>{a}</option>)}
    </select>
    {app && typesError ? <span className="sched-app-err" role="alert">{typesError}</span> : null}
    {app && !typesError && types === null ? <span className="calm" role="status">Loading events…</span> : null}
    {app && types ? types.length ? <select className="iv-in" aria-label="Event" value={slug} disabled={disabled} onChange={event => onSlug(event.target.value)}>
      <option value="">Choose an event</option>
      {types.map(t => <option key={t.slug} value={t.slug}>{t.name}</option>)}
    </select> : <span className="calm">{app} has no events to start from.</span> : null}
    {type?.description ? <small className="calm">{type.description}</small> : null}
    {fields.map(f => {
      const id = `app-cfg-${f.key}`;
      const label = `${f.label}${f.required ? ' *' : ''}`;
      const value = values[f.key] ?? f.initial;
      return <div key={f.key} className="sched-app-field">
        {f.type === 'boolean'
          ? <label htmlFor={id}><input id={id} type="checkbox" checked={value === true} disabled={disabled} onChange={event => set(f.key, event.target.checked)}/> {label}</label>
          : <>
            <label className="iv-l" htmlFor={id}>{label}</label>
            {f.type === 'enum'
              ? <select className="iv-in" id={id} value={String(value)} disabled={disabled} onChange={event => set(f.key, event.target.value)}>
                {f.required ? null : <option value="">Any</option>}
                {f.options.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
              : f.type === 'json'
                ? <textarea className="iv-in" id={id} rows={3} spellCheck={false} value={String(value)} readOnly={disabled} placeholder="JSON" onChange={event => set(f.key, event.target.value)}/>
                : <input className="iv-in" id={id} type={f.type === 'string' ? 'text' : 'number'} step={f.type === 'integer' ? 1 : 'any'} value={String(value)} readOnly={disabled}
                  onChange={event => set(f.key, event.target.value)}/>}
          </>}
        {f.description ? <small className="calm">{f.description}</small> : null}
      </div>;
    })}
  </div>;
}
