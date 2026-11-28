"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { FeedbackRating, FeedbackReason } from "@/lib/ai/feedback";

export interface MyFeedback {
  rating: FeedbackRating;
  reason: FeedbackReason | null;
}

/**
 * The signed-in teammate's ratings of the AI replies in one conversation, and a way to change them.
 * (Row-level security returns only your own rows here.) Rating the same way again takes the rating back.
 */
export function useAiFeedback(conversationId: string | null | undefined) {
  const t = useTranslations("Inbox.feedback");
  const { user } = useAuth();
  const [mine, setMine] = useState<Record<string, MyFeedback>>({});

  useEffect(() => {
    setMine({});
    if (!conversationId || !user?.id) return;
    let alive = true;
    void createClient()
      .from("ai_message_feedback")
      .select("message_id, rating, reason")
      .eq("conversation_id", conversationId)
      .eq("user_id", user.id)
      .then(({ data }) => {
        if (!alive) return;
        const next: Record<string, MyFeedback> = {};
        for (const r of (data ?? []) as { message_id: string; rating: FeedbackRating; reason: FeedbackReason | null }[]) {
          next[r.message_id] = { rating: r.rating, reason: r.reason };
        }
        setMine(next);
      });
    return () => {
      alive = false;
    };
  }, [conversationId, user?.id]);

  const rate = useCallback(
    async (messageId: string, rating: FeedbackRating, reason: FeedbackReason | null = null) => {
      const previous = mine[messageId];
      const clearing = previous?.rating === rating && rating === "up";
      // Optimistic: the thumb lights up at once; undone if the save fails.
      setMine((m) => {
        const next = { ...m };
        if (clearing) delete next[messageId];
        else next[messageId] = { rating, reason };
        return next;
      });
      try {
        const res = clearing
          ? await fetch(`/api/ai/feedback?message_id=${messageId}`, { method: "DELETE" })
          : await fetch("/api/ai/feedback", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message_id: messageId, rating, reason }),
            });
        if (!res.ok) throw new Error("failed");
        if (!clearing) toast.success(rating === "up" ? t("thanksUp") : t("thanksDown"));
      } catch {
        setMine((m) => {
          const next = { ...m };
          if (previous) next[messageId] = previous;
          else delete next[messageId];
          return next;
        });
        toast.error(t("failed"));
      }
    },
    [mine, t],
  );

  return { mine, rate };
}
