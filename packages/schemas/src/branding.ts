import { z } from "zod";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color");
const logo = z.string().max(350_000).refine(value => {
  if (!value) return true;
  if (/^\/brand\/[a-zA-Z0-9_.-]+$/.test(value)) return true;
  if (/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/]+=*$/.test(value)) return true;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }
  catch { return false; }
}, "Use an HTTPS image URL, a /brand/ asset, or a PNG, JPEG or WebP upload");

export const BrandingSchema = z.object({
  displayName: z.string().trim().min(1).max(60),
  logoUrl: logo,
  primaryColor: color,
  accentColor: color,
  backgroundColor: color,
}).strict();
export type Branding = z.infer<typeof BrandingSchema>;
export const DEFAULT_BRANDING: Branding = {
  displayName: "Nest", logoUrl: "", primaryColor: "#021814",
  accentColor: "#5dbc20", backgroundColor: "#eff0f0",
};
