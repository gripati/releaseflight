"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Spinner } from "@marquee/ui";
import { api } from "@/lib/apiClient";

export function TestCredentialButton({ credentialId }: { credentialId: string }): JSX.Element {
  const router = useRouter();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  function run(): void {
    setResult(null);
    startTransition(() => {
      void (async () => {
        const res = await api<{ ok: boolean; message: string }>(
          `/api/v1/credentials/${credentialId}/test`,
          { method: "POST" },
        );
        setResult(res.ok ? res.data : { ok: false, message: res.message });
        router.refresh();
      })();
    });
  }

  return (
    <div className="flex items-center gap-3">
      <Button variant="secondary" size="sm" onClick={run} disabled={isPending}>
        {isPending ? <Spinner size={12} /> : "Test connection"}
      </Button>
      {result && (
        <span
          className={`font-body text-[12px] ${result.ok ? "text-[var(--status-success)]" : "text-[var(--status-danger)]"}`}
        >
          {result.message}
        </span>
      )}
    </div>
  );
}
