import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { MentionNotification } from "@nest/schemas";
import { apiJson } from "../api";
import "./mentions.css";
export function MentionInbox({
  onOpen,
  icon,
  channelLabel,
}: {
  onOpen: (channelId: string, eventId: string) => void;
  icon?: ReactNode;
  channelLabel?: (channelId:string, fallback:string)=>string;
}) {
  const [items, setItems] = useState<MentionNotification[]>([]),
    [open, setOpen] = useState(false),
    [error, setError] = useState(false),
    [busy, setBusy] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
  }, [open]);
  const load = useCallback(async () => {
    try {
      const result = await apiJson<{ items: MentionNotification[] }>(
        "/api/mentions",
      );
      if (!Array.isArray(result.items)) throw Error("Invalid mention response");
      setItems(result.items);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    window.addEventListener("nest-message", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("nest-message", refresh);
    };
  }, [load]);
  function close() {
    dialog.current?.close();
    setOpen(false);
  }
  async function visit(item: MentionNotification) {
    setBusy(item.id);
    try {
      await apiJson("/api/mentions/" + encodeURIComponent(item.id) + "/read", {
        method: "POST",
      });
      setItems((current) =>
        current.map((n) =>
          n.id === item.id ? { ...n, readAt: Date.now() } : n,
        ),
      );
      close();
      onOpen(item.channelId, item.id);
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  }
  const unread = items.some((item) => !item.readAt);
  return (
    <section className={`mention-inbox ${icon ? "mention-inbox-header" : ""}`} aria-label="Mention notifications">
      <button
        className="mention-inbox-toggle"
        aria-label={icon ? "Notifications" : "Mentions"}
        title={icon ? "Notifications" : "Mentions"}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          void load();
        }}
      >
        {icon ?? "Mentions"}{" "}
        {unread && (
          <span className="mention-unread-dot" aria-label="Unread mentions" />
        )}
      </button>
      {open && (
        <dialog
          ref={dialog}
          className="mention-inbox-panel"
          aria-label="Your mentions"
          onCancel={(event) => {event.preventDefault();close();}}
          onClose={() => setOpen(false)}
        >
          <div className="mention-heading">
            Mentions{" "}
            <button aria-label="Close mentions" onClick={close}>
              ×
            </button>
          </div>
          {error && (
            <p role="alert">
              Could not load mentions.{" "}
              <button onClick={() => void load()}>Retry</button>
            </p>
          )}
          {!error && !items.length && (
            <p className="mention-empty">
              No mentions yet. People can notify you by selecting your name from
              @.
            </p>
          )}
          <div className="mention-inbox-items">
            {items.map((item) => (
              <button
                className={
                  item.readAt
                    ? "mention-notification"
                    : "mention-notification unread"
                }
                key={item.id}
                disabled={Boolean(busy)}
                onClick={() => void visit(item)}
              >
                <strong>{item.sender} mentioned you</strong>
                <span>{channelLabel?.(item.channelId,item.channelName) ?? item.channelName}</span>
                <p>{item.text}</p>
                <small>{new Date(item.createdAt).toLocaleString()}</small>
              </button>
            ))}
          </div>
        </dialog>
      )}
    </section>
  );
}
