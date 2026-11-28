"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { LifeBuoy } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useCan } from "@/hooks/use-can";
import { useAuth } from "@/hooks/use-auth";
import { isFeatureEnabled } from "@/lib/features/use-cases";
import { DealForm } from "@/components/pipelines/deal-form";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { Contact, Deal, Pipeline, PipelineStage } from "@/types";

type SupportPipeline = Pipeline & { stages: PipelineStage[] };

/**
 * Thread-header button: opens the chat's open support ticket, or creates
 * one (support pipeline, linked to this conversation and contact).
 */
export function CreateTicketButton({
  conversationId,
  contact,
  suggestedTitle,
}: {
  conversationId: string;
  contact: Contact;
  /** Usually the last customer message. */
  suggestedTitle?: string;
}) {
  const t = useTranslations("Inbox.ticket");
  const canCreate = useCan("send-messages");
  const { useCases } = useAuth();
  const [pipelines, setPipelines] = useState<SupportPipeline[] | null>(null);
  const [ticket, setTicket] = useState<Deal | null>(null);
  const [open, setOpen] = useState(false);
  const [pipelineId, setPipelineId] = useState("");
  // Captured when the form opens, so new messages arriving meanwhile
  // don't reset what the agent is typing.
  const [prefill, setPrefill] = useState<{
    contact: Contact;
    conversationId: string;
    title: string;
  } | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [pl, tk] = await Promise.all([
      supabase
        .from("pipelines")
        .select("*, stages:pipeline_stages(*)")
        .eq("kind", "support")
        .order("created_at"),
      supabase
        .from("deals")
        .select("*, contact:contacts(*), pipeline:pipelines!inner(kind)")
        .eq("conversation_id", conversationId)
        .eq("status", "open")
        .eq("pipeline.kind", "support")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const list = ((pl.data ?? []) as SupportPipeline[]).map((p) => ({
      ...p,
      stages: [...(p.stages ?? [])].sort((a, b) => a.position - b.position),
    }));
    setPipelines(list);
    setTicket((tk.data as Deal | null) ?? null);
  }, [conversationId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const activePipelineId = ticket?.pipeline_id ?? (pipelineId || pipelines?.[0]?.id || "");
  const active = useMemo(
    () => pipelines?.find((p) => p.id === activePipelineId) ?? null,
    [pipelines, activePipelineId],
  );
  const firstOpenStage = active?.stages.find((s) => !s.outcome);
  const ticketStage = ticket ? active?.stages.find((s) => s.id === ticket.stage_id) : null;

  if (pipelines === null) return null;
  // Only hide the entry point for workspaces without the support use case; an existing ticket stays reachable.
  if (!ticket && !isFeatureEnabled("action.createTicket", useCases)) return null;

  if (pipelines.length === 0) {
    return (
      <Link
        href="/pipelines?kind=support"
        title={t("noPipeline")}
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <LifeBuoy className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{t("create")}</span>
      </Link>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={!ticket && !canCreate}
        onClick={() => {
          setPrefill({
            contact,
            conversationId,
            title: suggestedTitle?.replace(/\s+/g, " ").trim().slice(0, 120) ?? "",
          });
          setOpen(true);
        }}
        title={ticket ? t("openTicket") : t("create")}
        className={cn(
          "inline-flex h-7 max-w-[11rem] items-center gap-1 rounded-md px-2 text-xs hover:bg-muted disabled:opacity-50",
          ticket ? "text-primary" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <LifeBuoy className="h-3.5 w-3.5 shrink-0" />
        <span className="hidden truncate sm:inline">
          {ticket ? t("current", { stage: ticketStage?.name ?? "" }) : t("create")}
        </span>
      </button>
      {active && (
        <DealForm
          open={open}
          onOpenChange={setOpen}
          deal={ticket}
          kind="support"
          pipelineId={active.id}
          stages={active.stages}
          defaultStageId={firstOpenStage?.id}
          onSaved={() => void load()}
          prefill={prefill ?? undefined}
          headerSlot={
            !ticket && pipelines.length > 1 ? (
              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("pipeline")}</Label>
                <select
                  value={active.id}
                  onChange={(e) => setPipelineId(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
                >
                  {pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null
          }
        />
      )}
    </>
  );
}
