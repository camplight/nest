// Nest-written: chat Markdown on react-markdown + remark-gfm (spec 7.1.1). Code blocks use the copied highlighter
// under a header with a "Copy code" button; links open in a new tab; tables and long code lines scroll in place.
import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Element, ElementContent } from "hast";
import { CheckIcon, CopyIcon } from "lucide-react";

import { SyntaxHighlighter } from "./syntax-highlighter";
import { TooltipIconButton } from "./tooltip-icon-button";
import { useCopyToClipboard } from "./hooks/use-copy-to-clipboard";
import { cn } from "./lib/utils";

const textOf = (nodes: ElementContent[]): string =>
  nodes.map((node) => (node.type === "text" ? node.value : node.type === "element" ? textOf(node.children) : "")).join("");

const Pre = ({ className, ...props }: ComponentPropsWithoutRef<"pre">) => (
  <pre className={cn("max-w-full overflow-x-auto bg-card text-[13px] leading-relaxed", className)} {...props} />
);
const Code = (props: ComponentPropsWithoutRef<"code">) => <code {...props} />;

function CodeBlock({ language, code }: { language: string; code: string }) {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  return (
    <div data-slot="code-block" className="my-3 max-w-full overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 bg-muted px-3 py-1 text-muted-foreground">
        <span className="font-mono text-xs lowercase">{language || "text"}</span>
        <TooltipIconButton tooltip="Copy code" side="left" onClick={() => copyToClipboard(code)}>
          {isCopied ? <CheckIcon /> : <CopyIcon />}
        </TooltipIconButton>
      </div>
      <SyntaxHighlighter language={language} code={code} components={{ Pre, Code }} />
    </div>
  );
}

const components: Components = {
  pre({ node }) {
    const code = node?.children.find((child): child is Element => child.type === "element" && child.tagName === "code");
    const classes = code?.properties.className;
    const language = (Array.isArray(classes) ? classes : []).map(String).find((name) => name.startsWith("language-"))?.slice(9) ?? "";
    return <CodeBlock language={language} code={textOf(code?.children ?? []).replace(/\n$/, "")} />;
  },
  code: ({ node: _node, className, ...props }) => (
    <code className={cn("rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.9em] break-words", className)} {...props} />
  ),
  a: ({ node: _node, className, ...props }) => (
    <a className={cn("text-(--nest-accent) underline underline-offset-2", className)} {...props} target="_blank" rel="noreferrer" />
  ),
  table: ({ node: _node, className, ...props }) => (
    <div data-slot="table-scroll" className="my-3 max-w-full overflow-x-auto">
      <table className={cn("w-max min-w-full border-collapse text-sm", className)} {...props} />
    </div>
  ),
  th: ({ node: _node, className, ...props }) => <th className={cn("border border-border bg-muted px-2 py-1 text-left font-medium", className)} {...props} />,
  td: ({ node: _node, className, ...props }) => <td className={cn("border border-border px-2 py-1", className)} {...props} />,
  p: ({ node: _node, className, ...props }) => <p className={cn("my-2 first:mt-0 last:mb-0", className)} {...props} />,
  ul: ({ node: _node, className, ...props }) => <ul className={cn("my-2 list-disc ps-5", className)} {...props} />,
  ol: ({ node: _node, className, ...props }) => <ol className={cn("my-2 list-decimal ps-5", className)} {...props} />,
  blockquote: ({ node: _node, className, ...props }) => <blockquote className={cn("my-2 border-s-2 border-border ps-3 text-muted-foreground", className)} {...props} />,
  h1: ({ node: _node, className, ...props }) => <h1 className={cn("mt-4 mb-2 text-lg font-semibold", className)} {...props} />,
  h2: ({ node: _node, className, ...props }) => <h2 className={cn("mt-4 mb-2 text-base font-semibold", className)} {...props} />,
  h3: ({ node: _node, className, ...props }) => <h3 className={cn("mt-3 mb-1 font-semibold", className)} {...props} />,
  hr: ({ node: _node, className, ...props }) => <hr className={cn("my-3 border-t border-border", className)} {...props} />,
};

export function MarkdownText({ text }: { text: string }): JSX.Element {
  return (
    <div data-slot="markdown-text" className="min-w-0 max-w-full break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
