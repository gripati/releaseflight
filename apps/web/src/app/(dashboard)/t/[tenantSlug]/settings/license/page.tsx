import { notFound } from "next/navigation";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { PageHeader } from "@/components/shell/PageHeader";
import { LicenseActivationForm } from "@/components/license/LicenseActivationForm";
import { Card, Divider, Stamp } from "@marquee/ui";
import { getLicenseStatus, licenseConfig } from "@marquee/license";
import type { Verdict } from "@marquee/license";

interface PageProps {
  params: Promise<{ tenantSlug: string }>;
}

export const dynamic = "force-dynamic";

// ---- Helpers ----------------------------------------------------------------

/** Format an epoch-seconds timestamp as a medium-length date string. */
function fmtEpoch(epochSeconds: number | null): string {
  if (epochSeconds === null) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
    new Date(epochSeconds * 1000),
  );
}

function statusStampVariant(
  verdict: Verdict | null,
): "default" | "success" | "warning" | "danger" {
  if (!verdict) return "default";
  if (verdict.ok && !verdict.withinGrace) return "success";
  if (verdict.ok && verdict.withinGrace) return "warning";
  return "danger";
}

function statusLabel(verdict: Verdict | null, enforced: boolean): string {
  if (!enforced) return "Not enforced";
  if (!verdict) return "Unknown";
  const labels: Record<string, string> = {
    valid: "Valid",
    grace: "Grace period",
    needs_activation: "Needs activation",
    expired: "Expired",
    fingerprint_mismatch: "Fingerprint mismatch",
    invalid: "Invalid",
  };
  return labels[verdict.state] ?? verdict.state;
}

// ---- Page -------------------------------------------------------------------

export default async function LicensePage({ params }: PageProps): Promise<JSX.Element> {
  const { tenantSlug } = await params;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

  const isOwner = tenant.role === "OWNER";

  // Read license state server-side — same source as GET /api/v1/license/status.
  const enforced = licenseConfig.enforcement;
  const verdict: Verdict | null = enforced ? getLicenseStatus() : null;

  return (
    <div className="page-loaded space-y-10">
      <PageHeader
        title="License"
        eyebrow={`Settings · ${tenant.slug}`}
        description="Manage this installation's Release Flight license. Only workspace Owners can activate or transfer a seat."
      />

      {/* ---- Current status ---- */}
      <section>
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
          Current status
        </h2>
        <Card>
          {!enforced ? (
            <div>
              <p className="font-body text-[13px] text-[var(--ink-secondary)]">
                License enforcement is <strong className="text-[var(--ink-primary)]">disabled</strong> on
                this installation. No activation is required.
              </p>
              <p className="mt-1.5 font-body text-[12px] text-[var(--ink-tertiary)]">
                To enable licensing, set <code className="rounded bg-[var(--surface-sunken)] px-1 font-mono text-[11px]">MARQUEE_LICENSE_ENFORCEMENT=true</code> and provide a license key.
              </p>
            </div>
          ) : (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[180px_1fr]">
              <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
                State
              </dt>
              <dd>
                <Stamp variant={statusStampVariant(verdict)}>
                  {statusLabel(verdict, enforced)}
                </Stamp>
              </dd>

              {verdict !== null && (
                <>
                  <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
                    Plan
                  </dt>
                  <dd className="font-body text-[13px]">{verdict.plan ?? "—"}</dd>

                  <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
                    Expires
                  </dt>
                  <dd className="font-mono text-[12px]">{fmtEpoch(verdict.notAfter)}</dd>

                  {verdict.withinGrace && verdict.graceUntil !== null && (
                    <>
                      <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
                        Grace until
                      </dt>
                      <dd className="font-mono text-[12px]">{fmtEpoch(verdict.graceUntil)}</dd>
                    </>
                  )}

                  {verdict.secondsUntilExpiry !== null && (
                    <>
                      <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
                        Time remaining
                      </dt>
                      <dd className="font-mono text-[12px]">
                        {verdict.secondsUntilExpiry > 0
                          ? `${Math.ceil(verdict.secondsUntilExpiry / 86400).toString()} day${Math.ceil(verdict.secondsUntilExpiry / 86400) === 1 ? "" : "s"}`
                          : "Expired"}
                      </dd>
                    </>
                  )}

                  {verdict.reason && (
                    <>
                      <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
                        Details
                      </dt>
                      <dd className="font-body text-[12px] text-[var(--ink-secondary)]">
                        {verdict.reason}
                      </dd>
                    </>
                  )}
                </>
              )}

              {verdict === null && (
                <>
                  <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
                    Details
                  </dt>
                  <dd className="font-body text-[12px] text-[var(--ink-secondary)]">
                    No license token found. Activate this installation below.
                  </dd>
                </>
              )}
            </dl>
          )}
        </Card>
      </section>

      {/* Only show activation UI when enforcement is on */}
      {enforced && (
        <>
          <Divider />

          <section>
            <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
              Activate or transfer
            </h2>
            <Card className="space-y-0">
              <LicenseActivationForm isOwner={isOwner} />
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
