const logos: Record<string, string> = {
  gmail: "gmail.svg", trello: "trello.svg", slack: "slack.svg",
  googledrive: "googledrive.svg", googlecalendar: "googlecalendar.svg",
  googledocs: "googledocs.png", googlesheets: "googlesheets.png",
  miro: "miro.svg", fathom: "fathom.png", wordpress: "wordpress.svg",
  github: "github.svg",
};

/** Local brand assets; adjacent app names provide the accessible label. */
export function IntegrationLogo({ toolkit }: { toolkit: string }) {
  const file = logos[toolkit];
  return <span className={`connection-app-logo${file ? "" : " is-generic"}`} aria-hidden="true">
    {file ? <img src={`/integrations/${file}`} alt="" width={26} height={26} /> : <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></svg>}
  </span>;
}
