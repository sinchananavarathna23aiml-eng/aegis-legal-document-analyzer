import { useCallback, useEffect, useRef, useState } from "react";
import { Clock3, Loader2, Plus, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { lexaChat } from "@/lib/legal/ai";
import { cn } from "@/lib/utils";
import { listChatThreads, loadChatThread, type LegalChatThreadSummary } from "@/lib/persistence";

type LexaMessage = { role: "user" | "assistant"; content: string };

export function LexaChat({
  open,
  onClose,
  fullPage = false,
  documentText,
  documentName,
  documentVersion,
  onRestoreDocument,
}: {
  open: boolean;
  onClose: () => void;
  fullPage?: boolean;
  documentText: string;
  documentName: string;
  documentVersion: number;
  onRestoreDocument?: (text: string, name: string) => void;
}) {
  const [messages, setMessages] = useState<LexaMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [threads, setThreads] = useState<LegalChatThreadSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const hasDoc = documentText.trim().length > 0;

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void listChatThreads().then(setThreads).catch(() => setThreads([]));
  }, [open]);

  useEffect(() => {
    setMessages([]);
    setThreadId(undefined);
    setError(null);
  }, [documentVersion]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;

    setInput("");
    setError(null);
    const userMsg: LexaMessage = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setBusy(true);

    try {
      const res = await lexaChat({
        data: {
          messages: [...messages, userMsg],
          documentText,
          documentName,
          threadId,
        },
      });
      if ("threadId" in res && res.threadId) setThreadId(res.threadId);
      if (res.ok) {
        setMessages((prev) => [...prev, { role: "assistant", content: res.text }]);
        void listChatThreads().then(setThreads).catch(() => undefined);
      } else {
        setError(res.error);
      }
    } catch {
      setError("Lexa could not respond. Try again.");
    } finally {
      setBusy(false);
    }
  }, [input, busy, messages, documentText, documentName, threadId]);

  async function restoreThread(id: string) {
    setHistoryBusy(true);
    try {
      const thread = await loadChatThread(id);
      if (!thread) return;
      setThreadId(thread.id);
      setMessages(thread.messages);
      setShowHistory(false);
      onRestoreDocument?.(thread.documentText, thread.documentName);
    } catch {
      setError("This conversation could not be loaded.");
    } finally {
      setHistoryBusy(false);
    }
  }

  function newConversation() {
    setThreadId(undefined);
    setMessages([]);
    setShowHistory(false);
    setError(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <>
      {/* Backdrop */}
      {open ? (
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity lg:hidden"
          onClick={onClose}
        />
      ) : null}

      {/* Panel */}
      <aside
        className={cn(
          "fixed z-50 flex flex-col bg-surface shadow-[var(--shadow-panel)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
          fullPage ? "inset-0 w-full" : "inset-y-0 right-0 w-full border-l border-border sm:w-[420px]",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <div className="flex size-8 items-center justify-center overflow-hidden rounded-full bg-white">
            <img src="/aegis-logo.png" alt="Aegis advocate emblem" className="size-full object-contain" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-fg">Lexa AI</p>
            <p className="text-[11px] text-subtle">
              {hasDoc ? `Analyzing: ${documentName}` : "No document loaded"}
            </p>
          </div>
          <button type="button" onClick={newConversation} className="flex size-8 items-center justify-center rounded-lg text-muted transition hover:bg-elevated hover:text-fg" title="New conversation" aria-label="New conversation"><Plus className="size-4" /></button>
          <button type="button" onClick={() => setShowHistory((shown) => !shown)} className={cn("flex size-8 items-center justify-center rounded-lg transition hover:bg-elevated", showHistory ? "bg-elevated text-fg" : "text-muted")} title="Chat history" aria-label="Chat history"><Clock3 className="size-4" /></button>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-[var(--radius-sm)] text-muted hover:bg-elevated hover:text-fg transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {showHistory && <div className="max-h-56 overflow-y-auto border-b border-border bg-bg px-3 py-2">
          <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[.16em] text-subtle">Saved conversations</p>
          {historyBusy ? <p className="px-2 py-3 text-xs text-muted">Loading history…</p> : threads.length ? threads.map((thread) => <button key={thread.id} onClick={() => void restoreThread(thread.id)} className="block w-full rounded-lg px-2 py-2 text-left transition hover:bg-elevated"><span className="block truncate text-xs font-medium">{thread.documentName}</span><span className="mt-0.5 block truncate text-[10px] text-muted">{thread.preview || "New conversation"}</span></button>) : <p className="px-2 py-3 text-xs text-muted">Your saved chats will appear here.</p>}
        </div>}

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.length === 0 && !busy ? (
            <div className="flex h-full flex-col items-center justify-center text-center px-4">
              <div className="flex size-12 items-center justify-center overflow-hidden rounded-full bg-white">
                <img src="/aegis-logo.png" alt="Aegis advocate emblem" className="size-full object-contain" />
              </div>
              <p className="mt-4 text-sm font-medium text-fg">Ask Lexa anything</p>
              <p className="mt-1 text-xs text-muted max-w-[260px]">
                {hasDoc
                  ? "Lexa will answer based on the currently loaded document."
                  : "Load a document in the Analyze tab first, then ask Lexa to review it."}
              </p>
              {hasDoc && (
                <div className="mt-4 flex flex-wrap gap-1.5 justify-center">
                  {["What are the key risks?", "Summarize the obligations", "Who are the parties?"].map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => setInput(q)}
                      className="rounded-full border border-border px-3 py-1 text-[11px] text-muted hover:border-accent hover:text-accent transition-colors"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            messages.map((m, i) => (
              <div
                key={i}
                className={cn(
                  "max-w-[92%] rounded-[var(--radius-md)] px-3.5 py-2.5 text-sm leading-relaxed",
                  m.role === "user"
                    ? "ml-auto bg-accent text-accent-fg"
                    : "bg-elevated text-fg",
                )}
              >
                {m.content}
              </div>
            ))
          )}
          {busy ? (
            <div className="flex items-center gap-2 text-muted text-sm">
              <Loader2 className="size-3.5 animate-spin" />
              Lexa is thinking...
            </div>
          ) : null}
          {error ? (
            <div className="rounded-[var(--radius-sm)] border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          ) : null}
        </div>

        {/* Input */}
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-end gap-2 rounded-[var(--radius-md)] border border-border bg-bg p-2 focus-within:border-accent/50 transition-colors">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder={hasDoc ? "Ask about this document..." : "Load a document first..."}
              className="flex-1 resize-none bg-transparent text-sm text-fg placeholder:text-subtle outline-none min-h-[24px] max-h-[120px]"
              style={{ fieldSizing: "content" }}
              disabled={!hasDoc}
            />
            <Button
              size="icon"
              variant="ghost"
              className="size-8 shrink-0"
              onClick={() => void send()}
              disabled={!input.trim() || busy || !hasDoc}
            >
              <Send className="size-3.5" />
            </Button>
          </div>
          <p className="mt-1.5 text-[10px] text-subtle text-center">
            Lexa is not a lawyer. Verify critical findings.
          </p>
        </div>
      </aside>
    </>
  );
}
