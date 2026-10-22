export type AgentRequestLocation = {
  active: boolean;
  requestId: string | null;
  assistant: string | null;
};
export function readAgentRequestLocation(): AgentRequestLocation {
  const url = new URL(window.location.href);
  return {
    active:
      url.searchParams.get("view") === "agents" &&
      url.searchParams.get("tab") === "requests",
    requestId: url.searchParams.get("request"),
    assistant: url.searchParams.get("assistant"),
  };
}
