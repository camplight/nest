/// <reference types="react-syntax-highlighter" />
// Adapted from assistant-ui (MIT, see LICENSE): packages/ui/src/components/react/assistant-ui/elements/syntax-highlighter.tsx
// at tag @assistant-ui/react@0.15.31. Nest changes: styles from the ESM build (Vite serves ESM); the copied light/dark pair
// switches on data-theme through chat.css's dark variant; the synchronous PrismLight build imported by path with an explicit
// language set, instead of @assistant-ui/react-syntax-highlighter (which imports the package root and makes Vite emit every
// highlight.js and Prism grammar as a lazy chunk). Unregistered languages render as plain code.
import type { ComponentProps } from "react";
import PrismLight from "react-syntax-highlighter/dist/esm/prism-light";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";

import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";

import {
  coldarkCold,
  coldarkDark,
} from "react-syntax-highlighter/dist/esm/styles/prism";

const languages: Record<string, unknown> = {
  js: tsx, javascript: tsx, jsx: tsx, ts: tsx, typescript: tsx, tsx,
  python, py: python,
  json,
  bash, sh: bash, shell: bash, zsh: bash,
  css,
  html: markup, xml: markup, svg: markup, markup,
  yaml, yml: yaml,
  sql,
  markdown, md: markdown,
  diff,
};
for (const [name, grammar] of Object.entries(languages)) PrismLight.registerLanguage(name, grammar);

const syntaxHighlighterCustomStyle = {
  // Unset so the markdown Pre's theme surface shows instead of the Prism theme's own background.
  background: undefined,
  margin: 0,
  width: "100%",
  padding: "1.5rem 1rem",
};

type HighlighterConfig = Omit<ComponentProps<typeof PrismLight>, "children" | "language" | "PreTag" | "CodeTag">;

// Same shape as assistant-ui's makeMakeSyntaxHighlighter: Pre and Code come from the markdown renderer.
const makeHighlighter = (config: HighlighterConfig) => {
  const Highlighter = ({ components: { Pre, Code }, language, code }: SyntaxHighlighterProps) => (
    <PrismLight PreTag={Pre} CodeTag={Code} {...config} language={language}>
      {code}
    </PrismLight>
  );
  Highlighter.displayName = "PrismSyntaxHighlighter";
  return Highlighter;
};

const LightSyntaxHighlighter = makeHighlighter({
  style: coldarkCold,
  customStyle: syntaxHighlighterCustomStyle,
  className: "dark:hidden",
});

const DarkSyntaxHighlighter = makeHighlighter({
  style: coldarkDark,
  customStyle: syntaxHighlighterCustomStyle,
  className: "hidden dark:block",
});

export const SyntaxHighlighter = (props: SyntaxHighlighterProps) => (
  <>
    <LightSyntaxHighlighter {...props} />
    <DarkSyntaxHighlighter {...props} />
  </>
);
