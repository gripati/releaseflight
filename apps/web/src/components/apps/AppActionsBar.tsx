"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DownloadCloud, Rocket } from "lucide-react";
import { Button, Spinner } from "@marquee/ui";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";
import { ConfirmDialog } from "@/components/feedback/ConfirmDialog";

interface Props {
  appId: string;
  platform: "IOS" | "ANDROID";
  dirtyCount: number;
}

/**
 * App-level Pull / Push actions in the detail header.
 *
 * All status feedback flows through the global toast surface (top-right)
 * — NEVER inline next to the buttons. The buttons themselves show a
 * spinner + go disabled while their respective action is in flight, so
 * the user can't double-fire requests.
 */
export function AppActionsBar({ appId, dirtyCount }: Props): JSX.Element {
  const router = useRouter();
  const [pulling, startPull] = useTransition();
  const [pushing, startPush] = useTransition();
  const [confirmPull, setConfirmPull] = useState(false);

  function pull(overwrite = false): void {
    startPull(() => {
      void (async () => {
        const t = toast.loading(
          overwrite ? "Overwriting local edits…" : "Pulling from store…",
          { description: "Reading metadata for every locale" },
        );
        const res = await api<{ ok: boolean; locales: number }>(
          `/api/v1/apps/${appId}/metadata/fetch`,
          { method: "POST", body: { overwriteLocalEdits: overwrite } },
        );
        if (!res.ok) {
          toast.dismiss(t);
          if (res.code === "CONFLICT") {
            setConfirmPull(true);
            return;
          }
          toast.error("Pull failed", { description: res.message });
          return;
        }
        toast.success("Metadata fetched", {
          id: t,
          description: `${res.data.locales.toString()} locale${res.data.locales === 1 ? "" : "s"} synced from the store.`,
        });
        router.refresh();
      })();
    });
  }

  function push(): void {
    startPush(() => {
      void (async () => {
        const t = toast.loading("Pushing to store…", {
          description: `${dirtyCount.toString()} locale${dirtyCount === 1 ? "" : "s"} pending push`,
        });
        const res = await api<{
          pushed: number;
          failed: number;
          rateLimited?: number;
          unsupported?: unknown[];
          results?: { locale: string; success: boolean; detail: string }[];
        }>(`/api/v1/apps/${appId}/metadata/push`, {
          method: "POST",
          body: { includeVersionSettings: true },
        });
        if (!res.ok) {
          toast.error("Push failed", { id: t, description: res.message });
          return;
        }
        const pieces: string[] = [];
        if (res.data.pushed > 0) pieces.push(`${res.data.pushed.toString()} pushed`);
        if (res.data.failed > 0) pieces.push(`${res.data.failed.toString()} failed`);
        if (res.data.rateLimited && res.data.rateLimited > 0) {
          pieces.push(`${res.data.rateLimited.toString()} rate-limited`);
        }
        if (Array.isArray(res.data.unsupported) && res.data.unsupported.length > 0) {
          pieces.push(`${res.data.unsupported.length.toString()} unsupported`);
        }
        // Surface the first skip reason so the user knows WHY a row
        // looked like "success" but didn't reach Apple.
        const firstSkip = res.data.results?.find(
          (r) => !r.success && r.detail.startsWith("Nothing pushed"),
        );
        const description = firstSkip
          ? firstSkip.detail
          : pieces.length > 0
            ? pieces.join(" · ")
            : "Nothing to push";

        const onlyRateLimited =
          res.data.rateLimited === res.data.failed && res.data.pushed === 0;
        if (onlyRateLimited && (res.data.rateLimited ?? 0) > 0) {
          toast.warning("Apple rate-limited", {
            id: t,
            description: `${res.data.rateLimited!.toString()} locales hit the rate limit. Try again in ~60 seconds — Apple resets the bucket then.`,
          });
        } else if (res.data.failed > 0 && res.data.pushed === 0) {
          toast.error("Push rejected", { id: t, description });
        } else if (res.data.failed > 0) {
          toast.warning("Pushed with issues", { id: t, description });
        } else if (res.data.pushed > 0) {
          toast.success("Push complete", { id: t, description });
        } else {
          toast.warning("Nothing to push", {
            id: t,
            description: "No dirty locales to send to the store.",
          });
        }
        router.refresh();
      })();
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="md" onClick={() => pull(false)} disabled={pulling}>
          {pulling ? <Spinner size={12} /> : <DownloadCloud size={14} />}
          {pulling ? "Pulling…" : "Pull from store"}
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={push}
          disabled={pushing || dirtyCount === 0}
        >
          {pushing ? <Spinner size={12} /> : <Rocket size={14} />}
          {pushing ? "Pushing…" : `Push${dirtyCount > 0 ? ` (${dirtyCount.toString()})` : ""}`}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmPull}
        onClose={() => !pulling && setConfirmPull(false)}
        onConfirm={() => {
          setConfirmPull(false);
          pull(true);
        }}
        title="Overwrite local edits?"
        description={
          <>
            You have unpushed changes. Fetching from the store will overwrite
            them with whatever is currently published.
          </>
        }
        confirmLabel="Overwrite & pull"
        variant="warning"
        pending={pulling}
      />
    </>
  );
}
