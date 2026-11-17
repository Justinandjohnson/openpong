"use client";

import { useCopilotChatInternal } from "@copilotkit/react-core";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { CoachChat } from "@/components/coach-chat";
import { buttonClassName } from "@/components/ui/button";

/** Reads ?prompt= and hands it to the same agent the dashboard uses. */
function PromptBridge() {
  const params = useSearchParams();
  const { sendMessage } = useCopilotChatInternal();
  const sent = useRef<string | null>(null);
  const prompt = params.get("prompt");

  useEffect(() => {
    if (!prompt || sent.current === prompt) return;
    sent.current = prompt;
    void sendMessage({ id: crypto.randomUUID(), role: "user", content: prompt } as never);
  }, [prompt, sendMessage]);

  return null;
}

export default function ChatPage() {
  return (
    <div className="flex h-[calc(100vh-9rem)] min-h-[520px] flex-col gap-2">
      <Suspense fallback={null}>
        <PromptBridge />
      </Suspense>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">
          Your coach runs on this machine with your data — nothing is simulated.
        </p>
        <Link href="/" className={buttonClassName({ variant: "ghost", size: "sm" })}>
          <ArrowLeft className="size-3.5" /> Dashboard
        </Link>
      </div>
      <CoachChat className="min-h-0 flex-1" />
    </div>
  );
}
