"use client";
import { useEffect } from "react";
import { Button, Card } from "@marquee/ui";

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function AppDetailError({ error, reset }: Props): JSX.Element {
  useEffect(() => {
    console.error("[AppDetailError]", error);
  }, [error]);
  return (
    <Card className="border-l-2 border-l-[var(--status-danger)]">
      <p className="mb-2 font-mono text-[10px] tracking-[0.12em] text-[var(--status-danger)] uppercase">
        App load error
      </p>
      <h2 className="font-display text-xl" style={{ fontVariationSettings: "'wght' 500" }}>
        We couldn't load this app
      </h2>
      <p className="font-body mt-2 text-[13px] text-[var(--ink-secondary)]">{error.message}</p>
      <div className="mt-4">
        <Button variant="primary" onClick={() => reset()}>
          Retry
        </Button>
      </div>
    </Card>
  );
}
