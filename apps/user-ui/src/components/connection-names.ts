import { friendlyActionName } from "@nest/schemas";
// Display names for connected apps and their actions. Pure, so the canvas can use them without the UI.
const appNames: Record<string, string> = {
  gmail: "Gmail", trello: "Trello", slack: "Slack", miro: "Miro",
  googledrive: "Google Drive", googlecalendar: "Google Calendar",
  googlesheets: "Google Sheets", googledocs: "Google Docs",
  fathom: "Fathom", wordpress: "WordPress", github: "GitHub",
};
export function connectionAppName(slug: string) {
  return appNames[slug] ?? slug.replaceAll("_", " ").replace(/^./, char => char.toUpperCase());
}
/** Provider identifiers are presentation only. Grants always use the exact slug. */
export function actionName(action: { slug: string; name?: string }, toolkit: string) {
  return friendlyActionName(action.name ?? "", action.slug, toolkit);
}
