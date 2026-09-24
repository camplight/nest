import type { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { schema, type NestDrizzleDb } from "@nest/db";
import { BrandingSchema, DEFAULT_BRANDING } from "@nest/schemas";

type Deps = {
  orm: NestDrizzleDb;
  requireAuth: (c: any, next: any) => any;
  jsonResponse: (c: any, data: unknown, status?: number) => Response;
  insertEvent: (event: any) => any;
};
export function registerBrandingRoutes(app: Hono<any>, { orm, requireAuth, jsonResponse, insertEvent }: Deps) {
  function canManage(c: any) {
    const user = c.get("user");
    const owner = orm.select({ id: schema.humans.id }).from(schema.humans)
      .orderBy(asc(schema.humans.created_at), asc(schema.humans.id)).limit(1).get();
    return Boolean(user?.id && user.id === owner?.id && !user.mustChangePassword);
  }
  // Registered before the general auth middleware: sign-in pages need branding.
  app.get("/api/branding", c => {
    const row = orm.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.key, "branding")).get();
    let value = DEFAULT_BRANDING;
    if (row) {
      try { value = BrandingSchema.parse(JSON.parse(row.value_json)); } catch { /* Preserve a usable login page. */ }
    }
    c.header("Cache-Control", "no-store");
    return jsonResponse(c, value);
  });
  app.get("/api/branding/access", requireAuth, c => jsonResponse(c, { canManage: canManage(c) }));
  app.put("/api/branding", requireAuth, async c => {
    if (!canManage(c)) return jsonResponse(c, { error: "Only the instance owner can change branding" }, 403);
    const raw = await c.req.text();
    if (raw.length > 360_000) return jsonResponse(c, { error: "Logo is too large (maximum 250 KB)" }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return jsonResponse(c, { error: "Invalid JSON" }, 400); }
    const parsed = BrandingSchema.safeParse(body);
    if (!parsed.success) return jsonResponse(c, { error: parsed.error.issues[0]?.message ?? "Invalid branding" }, 400);
    const values = { key: "branding", value_json: JSON.stringify(parsed.data), updated_at: Date.now() };
    orm.insert(schema.instanceSettings).values(values).onConflictDoUpdate({ target: schema.instanceSettings.key, set: values }).run();
    insertEvent({ type: "audit.branding.updated", source: `human:${(c as any).get("user").username}`, payload: { displayName: parsed.data.displayName } });
    return jsonResponse(c, parsed.data);
  });
}
