# Chat UI kit

Styled components for the chat, adapted from [assistant-ui](https://github.com/assistant-ui/assistant-ui) at tag `@assistant-ui/react@0.15.31` (MIT, see `LICENSE`), plus a few Nest-written pieces. Every copied file starts with a comment naming its source path and the tag.

## 1. Copied files

| File here | Source at the tag | Nest changes |
| --- | --- | --- |
| `syntax-highlighter.tsx` | `packages/ui/src/components/react/assistant-ui/elements/syntax-highlighter.tsx` | Prism styles from the ESM build. The light/dark pair switches on `data-theme` through `chat.css`'s dark variant; the hidden one is `display: none`, so each block has one reachable copy button (in `MarkdownText`). |
| `tooltip-icon-button.tsx` | `.../assistant-ui/elements/tooltip-icon-button.radix.tsx` | Relative imports; props typed without React 19's ref-as-prop. |
| `day-separator.tsx` | `.../assistant-ui/elements/day-separator.tsx` | Takes `{ label }` instead of a message list; the divider markup is the registry's. Adds `role="separator"`. |
| `surfaces.ts` | `.../assistant-ui/elements/surfaces.tsx` | Only the `mono` class list day-separator uses. |
| `thread.tsx` | `.../assistant-ui/elements/thread.aui.tsx` | Only `ThreadViewport`, `ThreadViewportFooter` and `ThreadScrollToBottom`; primitives come through `../aui`. |
| `button.tsx` | `packages/ui/src/components/react/ui/radix/button.tsx` | `forwardRef` (React 18.3); the default and link variants use `--nest-accent` in dark mode, because `bg-primary` (`--nest-forest`) equals the dark `--nest-bg`. The destructive variant's text is `text-primary-foreground` instead of `text-white`. |
| `tooltip.tsx`, `dialog.tsx` | `packages/ui/src/components/react/ui/radix/{tooltip,dialog}.tsx` | `forwardRef` on the wrappers that render DOM; portals render into `.nest-chat-portal`. The dialog overlay is `bg-foreground/10` (dark: `bg-background/70`) instead of `bg-black/10`. |
| `lib/utils.ts` | `packages/ui/src/lib/utils.ts` | None. |
| `hooks/use-copy-to-clipboard.ts` | `packages/ui/src/hooks/use-copy-to-clipboard.ts` | None beyond dropping `"use client"`. |

All registry `@/` imports are rewritten to relative ones (the user UI has no alias).

## 2. Nest-written files

- `MarkdownText.tsx`: `MarkdownText({ text })` on `react-markdown` and `remark-gfm`. Fenced code goes through the copied highlighter under a header with a `Copy code` button; links get `target="_blank" rel="noreferrer"`; tables and long code lines scroll inside their own box, never the page.
- `ImageZoom.tsx`: `ImageZoom({ src, alt, open, onOpenChange })`, a dialog named by `alt` with the image and an `Open original` link.
- `portal.tsx`: the portal container (below).

## 3. Portal container

Radix portals never target `document.body`. Wrap the chat in `ChatPortalProvider`: it renders its children followed by an empty `div.nest-chat-portal` and puts that element in context. `DialogPortal` (used by `DialogContent`) and `TooltipContent` read it with `useChatPortal()` and pass it as the Radix `container`. Outside a provider, or before the div mounts, they render nothing, so a missing provider shows up as a dialog that does not open rather than an unstyled dialog on `body`.

```tsx
import { ChatPortalProvider } from "./ui/portal";

<ChatPortalProvider>
  <div className="nest-chat">…</div>
</ChatPortalProvider>
```

`.nest-chat-portal` is one of the three scopes `chat.css` styles (preflight and the reduced-motion layer), so portalled content gets the same reset and motion rules as the thread. Use one provider per mounted chat.

## 4. Colours

No chat `.tsx` file holds a colour literal (hex, `rgb()`, `hsl()` and the like, or a named or Tailwind palette colour); every colour comes from the token aliases in `chat.css`. `style-tokens.test.ts` enforces this for the whole `chat/` folder, these copies included.
