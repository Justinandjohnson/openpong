"use client";

import { useCopilotChatInternal } from "@copilotkit/react-core";
import { ArrowUp, Check, Loader2, RotateCcw, Sparkles, Square, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { buttonClassName } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ToolCall = { id?: string; function?: { name?: string; arguments?: string } };

type ChatMessage = {
  id?: string;
  role?: string;
  content?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
};

const TOOL_LABELS: Record<string, string> = {
  get_my_profile: "Reading your profile",
  search_player: "Looking up a player",
  get_player_profile: "Pulling the player profile",
  list_tournaments: "Scanning area tournaments",
  list_my_matches: "Reading your matches",
  get_analytics: "Crunching your numbers",
  sync_league: "Syncing league results",
  sync_data: "Refreshing the calendar",
  record_match: "Logging a match",
  signup_tournament: "Preparing a signup",
  watch_tournament: "Watching tournaments",
  delegate_task: "Starting background work",
  agent_status: "Checking the job",
  create_goal: "Setting a goal",
  watch_page: "Watching a page",
  remember_fact: "Remembering that",
  search_web: "Searching the web",
  browse_web: "Reading a page",
};

const STARTERS = [
  { title: "My rating", body: "What's my USATT rating and how has it moved?", icon: "rating" },
  { title: "Next tournaments", body: "Find tournaments near me this winter.", icon: "events" },
  { title: "My last match", body: "Show my last match and how I lost or won it.", icon: "match" },
  { title: "Watch my area", body: "Keep an eye on new tournaments near me.", icon: "watch" },
];

function toolLabel(name?: string): string {
  if (!name) return "Working";
  return TOOL_LABELS[name] ?? name.replace(/_/g, " ");
}

/** Renders coach copy line by line, turning - / * lines into real bullets. */
function MessageBody({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: Array<{ kind: "text"; lines: string[] } | { kind: "list"; items: string[] }> = [];

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const last = blocks[blocks.length - 1];
    if (bullet) {
      if (last && last.kind === "list") last.items.push(bullet[1]);
      else blocks.push({ kind: "list", items: [bullet[1]] });
    } else if (last && last.kind === "text") {
      last.lines.push(line);
    } else {
      blocks.push({ kind: "text", lines: [line] });
    }
  }

  return (
    <div className="space-y-2">
      {blocks.map((block) =>
        block.kind === "list" ? (
          <ul
            key={`list:${block.items[0]}`}
            className="list-disc space-y-0.5 pl-4 marker:text-accent"
          >
            {block.items.map((item) => (
              <li key={item}>
                <Line text={item} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={`text:${block.lines[0]}`} className="whitespace-pre-wrap">
            <Line text={block.lines.join("\n")} />
          </p>
        ),
      )}
    </div>
  );
}
function Line({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((part) =>
        part.startsWith("**") && part.endsWith("**") ? (
          <strong key={part} className="font-semibold text-foreground">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={part}>{part}</span>
        ),
      )}
    </>
  );
}

export function CoachChat({ className }: { className?: string }) {
  const { messages, sendMessage, isLoading, stopGeneration, reset } = useCopilotChatInternal();
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const list = (messages ?? []) as unknown as ChatMessage[];
  const conversation = list.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const answered = new Set(
    list.filter((message) => message.role === "tool").map((message) => message.toolCallId),
  );
  const empty = conversation.length === 0;

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [conversation.length, isLoading]);

  async function submit(text: string) {
    const content = text.trim();
    if (!content || isLoading) return;
    setDraft("");
    setFailed(null);
    try {
      await sendMessage({ id: crypto.randomUUID(), role: "user", content } as never);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "The coach could not answer just now.");
    }
  }

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card/40",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="relative grid size-7 place-items-center rounded-lg border border-accent/25 bg-accent/10">
            <span className="pong-ball size-2 rounded-full" />
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
              OpenPong coach
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              Same agent as your dashboard — it can read and act on your data.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            reset();
            setFailed(null);
            input.current?.focus();
          }}
          className={buttonClassName({ variant: "ghost", size: "sm" })}
          disabled={empty && !isLoading}
        >
          <RotateCcw className="size-3.5" /> New chat
        </button>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          {empty ? (
            <div className="flex flex-col gap-4 py-2">
              <div>
                <h2 className="text-xl font-black leading-tight tracking-tight">
                  What are we working on?
                </h2>
                <p className="mt-1 max-w-lg text-xs text-muted-foreground">
                  Ask about your rating, your league, or the next tournament — or hand me a job and
                  I&apos;ll run it in the background and ask before anything irreversible.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {STARTERS.map((starter) => (
                  <button
                    key={starter.title}
                    type="button"
                    onClick={() => void submit(starter.body)}
                    className="group flex flex-col items-start gap-1 rounded-xl border border-border bg-background/50 px-3.5 py-3 text-left transition hover:border-accent/40 hover:bg-accent/5"
                  >
                    <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-accent">
                      <Sparkles className="size-3" /> {starter.title}
                    </span>
                    <span className="text-xs text-muted-foreground">{starter.body}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {conversation.map((message) => {
            const text = typeof message.content === "string" ? message.content : "";
            if (message.role === "user") {
              return (
                <div key={message.id ?? message.content} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[13px] leading-relaxed text-primary-foreground">
                    {text}
                  </div>
                </div>
              );
            }
            const calls = message.toolCalls ?? [];
            const isLast = message.id === conversation[conversation.length - 1]?.id;
            return (
              <div key={message.id ?? message.content} className="flex flex-col gap-2">
                {calls.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {calls.map((call) => {
                      const done = !isLoading || !isLast || answered.has(call.id ?? "");
                      return (
                        <span
                          key={call.id ?? call.function?.name}
                          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/60 px-2.5 py-1 text-[10px] font-medium text-muted-foreground"
                        >
                          {done ? (
                            <Check className="size-3 text-accent" />
                          ) : (
                            <Loader2 className="size-3 animate-spin text-accent" />
                          )}
                          <Wrench className="size-3 opacity-60" />
                          {toolLabel(call.function?.name)}
                        </span>
                      );
                    })}
                  </div>
                ) : null}
                {text ? (
                  <div className="flex gap-2.5">
                    <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border border-accent/25 bg-accent/10">
                      <span className="pong-ball size-1.5 rounded-full" />
                    </span>
                    <div className="min-w-0 space-y-2 text-[13px] leading-relaxed text-foreground/90">
                      <MessageBody text={text} />
                    </div>
                  </div>
                ) : isLoading && isLast ? (
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Loader2 className="size-3 animate-spin text-accent" /> Thinking…
                  </div>
                ) : null}
              </div>
            );
          })}

          {failed ? (
            <p className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-[11px] text-primary">
              {failed}
            </p>
          ) : null}
        </div>
      </div>

      <div className="border-t border-border bg-background/40 px-4 py-3">
        <form
          className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-2xl border border-border bg-card px-2.5 py-2 focus-within:border-accent/50"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(draft);
          }}
        >
          <textarea
            ref={input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit(draft);
              }
            }}
            rows={1}
            placeholder="Ask your coach anything…"
            aria-label="Message the OpenPong coach"
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-1 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground/70"
          />
          {isLoading ? (
            <button
              type="button"
              onClick={() => stopGeneration()}
              className={buttonClassName({ variant: "secondary", size: "sm" })}
            >
              <Square className="size-3" /> Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!draft.trim()}
              aria-label="Send message"
              className={buttonClassName({ variant: "accent", size: "sm" })}
            >
              <ArrowUp className="size-3.5" /> Send
            </button>
          )}
        </form>
        <p className="mx-auto mt-2 w-full max-w-3xl text-[10px] text-muted-foreground/70">
          The coach reads your real data. Anything that registers, pays or messages you gets an
          approval in Activity first.
        </p>
      </div>
    </div>
  );
}
