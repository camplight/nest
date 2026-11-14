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
