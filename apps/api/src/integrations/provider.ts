export type Page<T> = { items: T[]; nextCursor: string | null };
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
};
/** Only provider-specific transport, payloads and identity namespacing live here. */
export interface ConnectionProvider {
  id: string;
  subject(ownerId: string): string;
  apps(search: string, cursor?: string): Promise<Page<AppIntegration>>;
  accounts(ownerId: string, cursor?: string): Promise<Page<ConnectedAccount>>;
  account(id: string): Promise<ConnectedAccount>;
  link(ownerId: string, toolkit: string): Promise<{ redirectUrl: string }>;
  revoke(id: string): Promise<void>;
  tools(
    toolkit: string,
    search: string,
    cursor?: string,
  ): Promise<Page<IntegrationTool>>;
  tool(slug: string): Promise<IntegrationTool>;
  execute(
    account: ConnectedAccount,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}
