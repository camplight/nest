import { describe, expect, it } from "vitest";
import { clampSidebarWidth, sidebarWidthStyle, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "./SidebarResizer";

describe("sidebar width", () => {
  it("keeps the chosen width within usable bounds", () => {
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(5000)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(300.4)).toBe(300);
  });

  it("leaves the default to CSS until a width is chosen", () => {
    expect(sidebarWidthStyle(null)).toBeUndefined();
    expect(sidebarWidthStyle(320)).toEqual({ "--sidebar-width": "320px" });
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

it("sizes every desktop shell grid from the resizable width", () => {
  // .app-shell and .product-shell are on the same element with equal specificity, so stylesheet
  // load order decides which grid wins; both must use --sidebar-width or dragging does nothing.
  const src = fileURLToPath(new URL("..", import.meta.url));
  const fixed: string[] = [];
  for (const file of readdirSync(src).filter((name) => name.endsWith(".css"))) {
    postcss.parse(readFileSync(src + file, "utf8")).walkRules(/\.(app|product)-shell\b/, (rule) => {
      rule.walkDecls("grid-template-columns", (decl) => {
        const columns = decl.value.trim();
        // Phone layouts are a single column with the sidebar as a drawer.
        if (/^(1fr|minmax\(0,\s*1fr\))$/.test(columns)) return;
        if (!columns.startsWith("var(--sidebar-width")) fixed.push(`${file}: ${rule.selector} { ${decl.prop}: ${columns} }`);
      });
    });
  }
  expect(fixed).toEqual([]);
});
