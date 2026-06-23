"use client";
/**
 * Root-level error boundary. Required by Next.js 15 App Router to handle
 * uncaught errors that escape the regular layout boundary.
 */
import { useEffect } from "react";

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: Props): JSX.Element {
  useEffect(() => {
    console.error("[GlobalError]", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          padding: "4rem 2rem",
          textAlign: "center",
          background: "#faf7f1",
          color: "#1c1917",
        }}
      >
        <p style={{ fontSize: 10, letterSpacing: "0.2em", marginBottom: 8, color: "#78716c" }}>
          ━━━ ERRATUM ━━━
        </p>
        <h1 style={{ fontSize: 28, fontWeight: 500, marginBottom: 16 }}>
          Something went sideways.
        </h1>
        <p style={{ fontSize: 13, color: "#57534e", marginBottom: 24 }}>
          {error.digest ? `Reference: ${error.digest}` : null}
        </p>
        <button
          onClick={reset}
          style={{
            background: "#1c1917",
            color: "#faf7f1",
            border: "none",
            padding: "10px 18px",
            fontSize: 13,
            cursor: "pointer",
            borderRadius: 4,
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
