import type {
  ConnectionProvider,
  ConnectedAccount,
  IntegrationTool,
} from "./provider";
// Extracted from the locally deployed skills/composio REST helpers. Service
// credentials stay in the API; callers cannot override the origin or auth headers.
export type ComposioConfig = {
  apiKey: string;
  instanceId: string;
  callbackUrl: string;
  authConfigs: Record<string, string>;
  fetch?: typeof fetch;
};
export function composioConfigFromEnv(): ComposioConfig | undefined {
  const apiKey = process.env.NEST_COMPOSIO_API_KEY;
  const instanceId = process.env.NEST_COMPOSIO_INSTANCE_ID;
  const callbackUrl = process.env.NEST_COMPOSIO_CALLBACK_URL;
  if (!apiKey || !instanceId || !callbackUrl) return;
  try {
    const authConfigs = JSON.parse(
      process.env.NEST_COMPOSIO_AUTH_CONFIGS ?? "{}",
    );
    if (
      !authConfigs ||
      Array.isArray(authConfigs) ||
      typeof authConfigs !== "object" ||
      Object.entries(authConfigs).some(
        ([key, value]) =>
          !/^[a-z0-9_]+$/.test(key) || typeof value !== "string" || !value,
      )
    )
      return;
    return { apiKey, instanceId, callbackUrl, authConfigs };
  } catch {
    return;
  }
}
export function createComposioClient(config: ComposioConfig) {
  const callback = new URL(config.callbackUrl);
  if (
    callback.protocol !== "https:" ||
    callback.username ||
    callback.password ||
    callback.hash ||
    callback.search
  )
    throw Error(
      "Composio callback must be a fixed HTTPS URL without query or fragment",
    );
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(config.instanceId))
    throw Error("Invalid Composio instance ID");
  const transport = config.fetch ?? fetch;
  async function request(
    path: string,
    options: {
      method?: string;
      query?: Record<string, string>;
      body?: unknown;
    } = {},
  ) {
    const url = new URL("https://backend.composio.dev/api/v3.1" + path);
    for (const [key, value] of Object.entries(options.query ?? {}))
      url.searchParams.set(key, value);
    const response = await transport(url, {
      method: options.method ?? "GET",
      headers: {
        "x-api-key": config.apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok)
      throw Error(`Composio request failed (${response.status})`);
    return (await response.json()) as any;
  }
  return {
    request,
    config,
    userId: (humanId: string) => `nest:${config.instanceId}:${humanId}`,
  };
}
export type ComposioClient = ReturnType<typeof createComposioClient>;

function account(value: any): ConnectedAccount {
  if (
    typeof value.id !== "string" ||
    typeof value.user_id !== "string" ||
    typeof value.toolkit?.slug !== "string" ||
    typeof value.status !== "string"
  )
    throw Error("Invalid provider account");
  return {
    id: value.id,
    subject: value.user_id,
    toolkit: value.toolkit.slug,
    status: value.status,
    disabled: Boolean(value.is_disabled),
    shared: value.experimental?.account_type === "SHARED",
  };
}
function tool(value: any): IntegrationTool {
  if (typeof value.slug !== "string" || typeof value.toolkit?.slug !== "string")
    throw Error("Invalid provider tool");
  return {
    slug: value.slug,
    name: value.name ?? value.slug,
    description: value.description ?? "",
    toolkit: value.toolkit?.slug,
    inputParameters: value.input_parameters,
  };
}
export function createComposioProvider(
  config: ComposioConfig,
): ConnectionProvider {
  const client = createComposioClient(config);
  const pageQuery = (cursor?: string) => ({
    limit: "50",
    ...(cursor ? { cursor } : {}),
  });
  return {
    id: "composio",
    subject: client.userId,
    async apps(search, cursor) {
      const r = await client.request("/toolkits", {
        query: { search, ...pageQuery(cursor) },
      });
      return {
        items: (r.items ?? []).map((v: any) => ({
          slug: v.slug,
          name: v.name,
          description: v.meta?.description ?? v.description ?? "",
          connectable: Boolean(config.authConfigs[v.slug]),
        })),
        nextCursor: r.next_cursor ?? null,
      };
    },
    async accounts(owner, cursor) {
      const r = await client.request("/connected_accounts", {
        query: {
          user_ids: client.userId(owner),
          account_type: "PRIVATE",
          ...pageQuery(cursor),
        },
      });
      return {
        items: (r.items ?? []).map(account),
        nextCursor: r.next_cursor ?? null,
      };
    },
    async account(id) {
      return account(
        await client.request(`/connected_accounts/${encodeURIComponent(id)}`),
      );
    },
    async link(owner, toolkit) {
      const authConfig = config.authConfigs[toolkit];
      if (!authConfig) throw Error("App requires administrator configuration");
      const r = await client.request("/connected_accounts/link", {
        method: "POST",
        body: {
          auth_config_id: authConfig,
          user_id: client.userId(owner),
          callback_url: config.callbackUrl,
        },
      });
      const url = new URL(r.redirect_url);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !(
          url.hostname === "composio.dev" ||
          url.hostname.endsWith(".composio.dev")
        )
      )
        throw Error("Invalid provider authorization URL");
      return { redirectUrl: url.toString() };
    },
    async revoke(id) {
      await client.request(
        `/connected_accounts/${encodeURIComponent(id)}/revoke`,
        { method: "POST" },
      );
    },
    async tools(toolkit, search, cursor) {
      const r = await client.request("/tools", {
        query: { toolkit_slug: toolkit, search, ...pageQuery(cursor) },
      });
      return {
        items: (r.items ?? [])
          .map(tool)
          .filter((t: IntegrationTool) => t.toolkit === toolkit),
        nextCursor: r.next_cursor ?? null,
      };
    },
    async tool(slug) {
      return tool(await client.request(`/tools/${encodeURIComponent(slug)}`));
    },
    async execute(account, slug, args) {
      return client.request(`/tools/execute/${encodeURIComponent(slug)}`, {
        method: "POST",
        body: {
          user_id: account.subject,
          connected_account_id: account.id,
          arguments: args,
        },
      });
    },
  };
}
