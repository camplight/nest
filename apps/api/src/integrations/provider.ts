/** A provider answered with an error status; `code` is its short error slug, never its message. */
export class ProviderRequestError extends Error {
  constructor(readonly status: number, readonly code?: string) {
    super(`Connection provider request failed (${status}${code ? ` ${code}` : ""})`);
    this.name = "ProviderRequestError";
  }
}
/** The app has no administrator configuration, so people cannot connect it yet. */
export class AppSetupRequiredError extends Error {
  constructor() {
    super("App requires administrator configuration");
    this.name = "AppSetupRequiredError";
  }
}
export type Page<T> = { items: T[]; nextCursor: string | null };
/** `total` is the provider-reported catalog size for an unsearched listing, when known. */
export type ToolPage = Page<IntegrationTool> & { total?: number };
export type AppIntegration = {
  slug: string;
  name: string;
  description: string;
  connectable: boolean;
};
export type ConnectedAccount = {
  id: string;
  subject: string;
  toolkit: string;
  status: string;
  disabled: boolean;
  shared: boolean;
};
export type IntegrationTool = {
  slug: string;
  name: string;
  description: string;
  toolkit: string;
  inputParameters: unknown;
  /** Provider hints such as readOnlyHint, createHint, updateHint and destructiveHint. */
  tags: string[];
};
/** Only provider-specific transport, payloads and identity namespacing live here. */
export interface ConnectionProvider {
  id: string;
  subject(ownerId: string): string;
  /** Without a search or cursor, only the apps an administrator configured. */
  apps(search: string, cursor?: string): Promise<Page<AppIntegration>>;
  accounts(ownerId: string, cursor?: string): Promise<Page<ConnectedAccount>>;
  account(id: string): Promise<ConnectedAccount>;
  link(ownerId: string, toolkit: string): Promise<{ redirectUrl: string }>;
  revoke(id: string): Promise<void>;
  tools(
    toolkit: string,
    search: string,
    cursor?: string,
  ): Promise<ToolPage>;
  tool(slug: string): Promise<IntegrationTool>;
  execute(
    account: ConnectedAccount,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}
