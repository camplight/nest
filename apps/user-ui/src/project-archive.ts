/** Splits projects into active ones and archived ones (their chat is archived), keeping order. */
export function splitArchived<T extends {archived?: boolean}>(projects: T[]): {active: T[]; archived: T[]} {
  return {active: projects.filter(project => !project.archived), archived: projects.filter(project => project.archived)};
}
