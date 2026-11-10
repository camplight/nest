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
export function actionName(action: { slug: string; name?: string }, toolkit: string) {
  const name = action.name?.trim() || action.slug;
  // Provider identifiers are presentation only. Grants always use the exact slug.
  const prefix = toolkit.replace(/[^a-z0-9]/gi, "");
  const words = name.replaceAll("_", " ").trim();
  const first = words.split(" ")[0];
  const title = first.replace(/[^a-z0-9]/gi, "").toLowerCase() === prefix.toLowerCase()
    ? words.slice(first.length).trim() : words;
  const friendly = title || words;
  return friendly === friendly.toUpperCase()
    ? friendly.toLowerCase().replace(/^./, char => char.toUpperCase()) : friendly;
}
