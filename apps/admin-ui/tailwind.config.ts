import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: { sans: ["Inter", "sans-serif"] },
      colors: {
        slate: {
          50: "var(--nest-text)", 100: "var(--nest-text)", 200: "var(--nest-text)",
          300: "var(--nest-muted)", 400: "var(--nest-muted)", 500: "var(--nest-muted)",
          600: "var(--nest-border)", 700: "var(--nest-border)",
          800: "var(--nest-muted-surface)", 900: "var(--nest-surface)", 950: "var(--nest-bg)"
        },
        blue: { 100: "#e9f5e2", 200: "#c4e8ae", 300: "var(--nest-accent)", 400: "var(--nest-accent)", 500: "#356d25", 600: "#244c36", 700: "#19372c", 800: "#19372c", 900: "#112a23" }
      }
    }
  },
  plugins: []
} satisfies Config;
