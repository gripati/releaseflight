import { headers } from "next/headers";
import { SLO_TARGETS, type SloTarget } from "@marquee/observability/slo";

interface Component { id: string; name: string; status: "operational" | "degraded" | "outage" }
interface StatusPayload { status: string; components: Component[]; slo: SloTarget[]; generatedAt: string }

async function fetchStatus(): Promise<StatusPayload | null> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  try {
    const res = await fetch(`${proto}://${host}/api/v1/status`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as StatusPayload;
  } catch {
    return null;
  }
}

function formatSlo(t: SloTarget): string {
  if (t.unit === "ratio") return `${(t.target * 100).toFixed(t.target >= 0.999 ? 3 : 2)}%`;
  if (t.unit === "ms") return `${t.target.toString()} ms`;
  return `${t.target.toString()} ${t.unit}`;
}

function dotColor(status: string): string {
  if (status === "operational") return "var(--status-success)";
  if (status === "degraded") return "var(--status-warning)";
  return "var(--status-danger)";
}

export const dynamic = "force-dynamic";

export default async function StatusPage(): Promise<JSX.Element> {
  const data = await fetchStatus();

  return (
    <div className="mx-auto min-h-screen max-w-2xl px-6 py-16 page-loaded">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--ink-tertiary)]">
        ━━━ STATUS ━━━
      </p>
      <h1
        className="font-display text-[44px] leading-[1.05] tracking-[-0.01em]"
        style={{ fontVariationSettings: "'wght' 600" }}
      >
        {data?.status === "operational" ? (
          <>
            All systems{" "}
            <em className="not-italic font-bold" style={{ color: "var(--status-success)" }}>
              operational.
            </em>
          </>
        ) : data?.status === "degraded" ? (
          <>
            Some systems{" "}
            <em className="not-italic font-bold" style={{ color: "var(--status-warning)" }}>
              degraded.
            </em>
          </>
        ) : (
          <>
            Service{" "}
            <em className="not-italic font-bold" style={{ color: "var(--status-danger)" }}>
              disrupted.
            </em>
          </>
        )}
      </h1>
      <p className="mt-2 font-mono text-[11px] text-[var(--ink-tertiary)]">
        Generated {data ? new Date(data.generatedAt).toLocaleString() : "—"}
      </p>

      <section className="mt-10">
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
          Components
        </h2>
        <ul className="overflow-hidden rounded-[var(--radius)] border border-[var(--stroke-default)]">
          {(data?.components ?? []).map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between border-b-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-elevated)] px-4 py-3 last:border-b-0"
            >
              <div className="flex items-center gap-3">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: dotColor(c.status) }}
                />
                <span className="font-body text-[13px]">{c.name}</span>
              </div>
              <span
                className="font-mono text-[10px] uppercase tracking-[0.08em]"
                style={{ color: dotColor(c.status) }}
              >
                {c.status}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
          Service-level objectives
        </h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[1fr_120px]">
          {Object.values(SLO_TARGETS).map((t) => (
            <>
              <dt key={`${t.id}-d`} className="font-body text-[13px]">
                {t.description}
              </dt>
              <dd
                key={`${t.id}-v`}
                className="text-right font-display text-[18px]"
                style={{ fontVariationSettings: "'wght' 500" }}
              >
                {formatSlo(t)}
              </dd>
            </>
          ))}
        </dl>
      </section>
    </div>
  );
}
