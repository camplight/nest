import type { AppTriggerType } from "@nest/schemas";
import type { ComposioClient } from "./composio";
import { ProviderRequestError, type AppTriggerProvider } from "./provider";

/** Pages of trigger types read per toolkit (50 each). */
const MAX_TYPE_PAGES = 5;
const TRIGGER_ID = /^[A-Za-z0-9_-]{1,200}$/;

function triggerType(value: any): AppTriggerType | null {
  if (typeof value?.slug !== "string") return null;
  return {
    slug: value.slug,
    name: typeof value.name === "string" ? value.name : value.slug,
    description: typeof value.description === "string" ? value.description : "",
    config: value.config && typeof value.config === "object" ? value.config : { type: "object", properties: {} },
  };
}

/** A provider refusal that means the instance is already in the wanted state. */
const already = (error: unknown, statuses: number[]) =>
  error instanceof ProviderRequestError && statuses.includes(error.status);

/**
 * Composio trigger instances (API v3.1) through the Composio client, so the fixed origin, service key, timeout and
 * error redaction are the client's. Instances are made on a connected account with Nest's receiver as `egress_url`;
 * Nest never creates or changes the project's webhook subscription.
 */
export function createComposioTriggers(client: ComposioClient): AppTriggerProvider {
  const manage = (triggerId: string) => `/trigger_instances/manage/${encodeURIComponent(triggerId)}`;
  return {
    async types(toolkit) {
      const items: AppTriggerType[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TYPE_PAGES; page++) {
        const r = await client.request("/triggers_types", {
          query: { toolkit_slugs: toolkit, limit: "50", ...(cursor ? { cursor } : {}) },
        });
        for (const item of r?.items ?? []) {
          const slug = item?.toolkit?.slug;
          const t = triggerType(item);
          if (t && (typeof slug !== "string" || slug.toLowerCase() === toolkit.toLowerCase())) items.push(t);
        }
        cursor = typeof r?.next_cursor === "string" && r.next_cursor ? r.next_cursor : undefined;
        if (!cursor) break;
      }
      return items;
    },
    async create({ slug, accountId, config, egressUrl }) {
      const r = await client.request(`/trigger_instances/${encodeURIComponent(slug)}/upsert`, {
        method: "POST",
        body: { connected_account_id: accountId, trigger_config: config, egress_url: egressUrl },
      });
      if (typeof r?.trigger_id !== "string" || !TRIGGER_ID.test(r.trigger_id)) throw Error("Invalid provider trigger");
      return { triggerId: r.trigger_id };
    },
    async setEnabled(triggerId, enabled) {
      try {
        await client.request(manage(triggerId), { method: "PATCH", body: { status: enabled ? "enable" : "disable" } });
      } catch (error) {
        if (!already(error, [409])) throw error;
      }
    },
    async remove(triggerId) {
      try {
        await client.request(manage(triggerId), { method: "DELETE" });
      } catch (error) {
        // Removed already (here, or in Composio's dashboard): nothing is left to remove.
        if (!already(error, [404, 409, 410])) throw error;
      }
    },
  };
}
