import { Card, Stamp } from "@marquee/ui";

/**
 * Seat-usage summary for the Seats page. Seats are counted INSTANCE-WIDE (one
 * distinct active billable user = one seat), so `used`/`seats` are global; the
 * current workspace holds `inThisWorkspace` of them. seats=null ⇒ unlimited.
 */
export interface SeatUsageCardProps {
  used: number;
  seats: number | null;
  inThisWorkspace: number;
  billingState: string;
  manageBillingUrl: string | null;
}

const BILLING_LABEL: Record<string, { label: string; variant: "success" | "info" | "warning" | "danger" | "default" }> = {
  active: { label: "Active", variant: "success" },
  grace: { label: "Grace period", variant: "warning" },
  past_due: { label: "Past due", variant: "warning" },
  seats_exceeded: { label: "Seats exceeded", variant: "danger" },
  suspended: { label: "Suspended", variant: "danger" },
};

export function SeatUsageCard({
  used,
  seats,
  inThisWorkspace,
  billingState,
  manageBillingUrl,
}: SeatUsageCardProps): JSX.Element {
  const unlimited = seats === null;
  const free = unlimited ? null : Math.max(0, seats - used);
  const atCap = !unlimited && free === 0;
  const elsewhere = Math.max(0, used - inThisWorkspace);
  const billing = BILLING_LABEL[billingState] ?? { label: billingState, variant: "default" as const };

  // Seat pills up to a sane count; switch to a bar for large plans.
  const showPills = !unlimited && seats !== null && seats <= 24;

  return (
    <Card className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
            Member seats
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-display text-[34px] font-semibold leading-none text-[var(--ink-primary)]">
              {used}
            </span>
            <span className="font-body text-[15px] text-[var(--ink-tertiary)]">
              {unlimited ? "in use · unlimited seats" : `of ${seats} seats used`}
            </span>
          </div>
          <div className="mt-1.5 font-body text-[12px] text-[var(--ink-secondary)]">
            {unlimited
              ? "This installation has no seat cap."
              : atCap
                ? "All seats are in use. Free one by removing a member, or add seats."
                : `${free} seat${free === 1 ? "" : "s"} available.`}
            {elsewhere > 0 ? ` ${elsewhere} held by members in your other workspaces.` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Stamp variant={billing.variant}>{billing.label}</Stamp>
          {manageBillingUrl ? (
            <a
              href={manageBillingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-[var(--radius-sm)] border border-[var(--stroke-default)] px-3 py-1.5 font-body text-[12px] font-medium text-[var(--ink-primary)] transition-colors hover:bg-[var(--surface-tinted)]"
            >
              {atCap ? "Add seats" : "Manage billing"}
            </a>
          ) : null}
        </div>
      </div>

      {showPills && seats !== null ? (
        <div className="flex flex-wrap gap-1.5" aria-hidden>
          {Array.from({ length: seats }).map((_, i) => (
            <span
              key={i}
              className="h-2.5 w-6 rounded-full"
              style={{
                background: i < used ? "var(--signal)" : "var(--surface-tinted)",
                border: i < used ? "none" : "1px solid var(--stroke-default)",
              }}
            />
          ))}
        </div>
      ) : !unlimited && seats !== null ? (
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--surface-tinted)]" aria-hidden>
          <span
            className="block h-full rounded-full"
            style={{ width: `${Math.min(100, (used / seats) * 100)}%`, background: "var(--signal)" }}
          />
        </div>
      ) : null}
    </Card>
  );
}
