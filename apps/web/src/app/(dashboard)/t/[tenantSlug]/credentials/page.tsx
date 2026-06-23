import { notFound } from "next/navigation";
import { Card, StateDot, Stamp, Divider } from "@marquee/ui";
import { tenantStorage, prisma } from "@marquee/db";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { PageHeader } from "@/components/shell/PageHeader";
import { AppleLogo, GooglePlayLogo } from "@/components/icons/BrandIcons";
import { CredentialsAddProvider } from "@/components/credentials/CredentialsAddProvider";
import { CredentialsToolbar } from "@/components/credentials/CredentialsToolbar";
import { TestCredentialButton } from "@/components/credentials/TestCredentialButton";
import { DeleteCredentialButton } from "@/components/credentials/DeleteCredentialButton";
import { EmptyCredentialsCTA } from "@/components/credentials/EmptyCredentialsCTA";
import { AppleVendorNumberEditor } from "@/components/credentials/AppleVendorNumberEditor";

interface PageProps {
  params: Promise<{ tenantSlug: string }>;
}

export default async function CredentialsPage({ params }: PageProps): Promise<JSX.Element> {
  const { tenantSlug } = await params;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

  const credentials = await tenantStorage.run(
    { tenantId: tenant.id, userId: session.user.id, role: tenant.role, requestId: crypto.randomUUID() },
    async () =>
      prisma.credential.findMany({
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { apps: true } } },
      }),
  );

  return (
    <CredentialsAddProvider>
      <div className="page-loaded">
        <PageHeader
          title="Credentials"
          eyebrow={`${credentials.length} registered`}
          description="API keys for App Store Connect and Google Play."
          actions={<CredentialsToolbar />}
        />

        {credentials.length === 0 ? (
          <EmptyCredentialsState />
        ) : (
        <ul className="flex flex-col gap-3">
          {credentials.map((c) => {
            const state = c.lastTestSucceeded === false ? "error" : c.lastTestSucceeded ? "synced" : "empty";
            return (
              <li key={c.id}>
                <Card>
                  <div className="flex items-start gap-4">
                    <StateDot state={state} className="mt-2" />
                    <div className="flex-1">
                      <div className="mb-1 flex items-center gap-3">
                        {c.kind === "APPLE" ? (
                          <AppleLogo size={16} className="shrink-0" />
                        ) : c.kind === "GOOGLE" ? (
                          <GooglePlayLogo size={16} className="shrink-0" />
                        ) : null}
                        <Stamp
                          variant={
                            c.kind === "APPLE"
                              ? "default"
                              : c.kind === "GOOGLE"
                                ? "success"
                                : "warning"
                          }
                        >
                          {c.kind}
                        </Stamp>
                        <h3
                          className="font-display text-lg leading-tight"
                          style={{ fontVariationSettings: "'wght' 500" }}
                        >
                          {c.name}
                        </h3>
                      </div>
                      <dl className="mt-3 grid grid-cols-1 gap-y-1 font-body text-[12px] text-[var(--ink-secondary)] md:grid-cols-2">
                        {c.kind === "APPLE" ? (
                          <>
                            <dt className="text-[var(--ink-tertiary)]">Issuer ID</dt>
                            <dd className="font-mono text-[11px]">{c.appleIssuerId ?? "—"}</dd>
                            <dt className="text-[var(--ink-tertiary)]">Key ID</dt>
                            <dd className="font-mono text-[11px]">{c.appleKeyId ?? "—"}</dd>
                            <dt className="text-[var(--ink-tertiary)]">
                              Vendor #{" "}
                              <span className="text-[10px] text-[var(--ink-tertiary)]">
                                (Sales Reports)
                              </span>
                            </dt>
                            <dd>
                              <AppleVendorNumberEditor
                                credentialId={c.id}
                                initial={c.appleVendorNumber ?? null}
                              />
                            </dd>
                          </>
                        ) : c.kind === "ASO_RESEARCH_MCP" ? (
                          (() => {
                            const meta = (c.metadata as { endpoint?: string } | null) ?? {};
                            return (
                              <>
                                <dt className="text-[var(--ink-tertiary)]">Endpoint</dt>
                                <dd className="truncate font-mono text-[11px]">
                                  {meta.endpoint ?? "—"}
                                </dd>
                              </>
                            );
                          })()
                        ) : (
                          <>
                            <dt className="text-[var(--ink-tertiary)]">Client</dt>
                            <dd className="truncate font-mono text-[11px]">{c.googleClientEmail ?? "—"}</dd>
                            <dt className="text-[var(--ink-tertiary)]">Project</dt>
                            <dd className="font-mono text-[11px]">{c.googleProjectId ?? "—"}</dd>
                          </>
                        )}
                        <dt className="text-[var(--ink-tertiary)]">Last test</dt>
                        <dd>
                          {c.lastTestedAt
                            ? new Date(c.lastTestedAt).toLocaleString()
                            : "—"}
                          {c.lastTestMessage ? (
                            <span className="block text-[var(--ink-tertiary)]">{c.lastTestMessage}</span>
                          ) : null}
                        </dd>
                        <dt className="text-[var(--ink-tertiary)]">Used by</dt>
                        <dd>{c._count.apps} app{c._count.apps === 1 ? "" : "s"}</dd>
                      </dl>
                    </div>
                  </div>
                  <Divider className="my-4" />
                  <div className="flex flex-wrap items-center gap-3">
                    <TestCredentialButton credentialId={c.id} />
                    <DeleteCredentialButton
                      credentialId={c.id}
                      credentialName={c.name}
                      appCount={c._count.apps}
                    />
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      </div>
    </CredentialsAddProvider>
  );
}

function EmptyCredentialsState(): JSX.Element {
  return (
    <div className="mx-auto max-w-xl py-16 text-center">
      <p className="mb-4 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--ink-tertiary)]">
        ━━  KEY STORAGE  ━━
      </p>
      <h2
        className="font-display text-[34px] leading-[1.05] tracking-[-0.01em]"
        style={{ fontVariationSettings: "'wght' 600" }}
      >
        Connect to Apple or Google.
      </h2>
      <p className="mx-auto mt-4 max-w-md font-body text-[13px] leading-[1.6] text-[var(--ink-secondary)]">
        Upload an App Store Connect .p8 key or a Google service-account JSON.
        Credentials never leave your secret manager — only metadata is stored in the database.
      </p>
      <div className="mt-8">
        <EmptyCredentialsCTA />
      </div>
    </div>
  );
}
