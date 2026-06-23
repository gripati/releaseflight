"use client";
import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@marquee/ui";

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: Props): JSX.Element {
  useEffect(() => {
    console.error("[GlobalError]", error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[80vh] max-w-xl flex-col items-center justify-center px-6 py-12 text-center">
      <p className="mb-4 font-mono text-[10px] tracking-[0.18em] text-[var(--ink-tertiary)] uppercase">
        ━━━━ ERRATUM ━━━━
      </p>
      <h1
        className="font-display text-[44px] leading-[1.05] tracking-[-0.01em]"
        style={{ fontVariationSettings: "'wght' 600" }}
      >
        Something went{" "}
        <em className="font-bold not-italic" style={{ color: "var(--signal)" }}>
          sideways.
        </em>
      </h1>
      <p className="font-body mt-4 max-w-md text-[13px] leading-[1.6] text-[var(--ink-secondary)]">
        We couldn't load this page. The error has been logged. Try refreshing — and if the problem
        persists, the activity log under your workspace has the details.
      </p>
      <div className="mt-2 font-mono text-[10px] text-[var(--ink-tertiary)]">
        {error.digest ?? error.message.slice(0, 80)}
      </div>
      <div className="mt-8 flex gap-2">
        <Button variant="primary" onClick={() => reset()}>
          Try again
        </Button>
        <Button asChild variant="ghost">
          <Link href="/login">Sign in again</Link>
        </Button>
      </div>
    </div>
  );
}
