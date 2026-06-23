import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/session";
import { prismaUnscoped } from "@marquee/db";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in" };

export default async function LoginPage(): Promise<JSX.Element> {
  const session = await getSessionFromCookie();
  if (session?.activeTenantId) {
    const tenant = await prismaUnscoped.tenant.findUnique({
      where: { id: session.activeTenantId },
      select: { slug: true },
    });
    // Already-signed-in operators bounce to /apps — the new canonical
    // landing now that the tenant Dashboard page is gone.
    if (tenant) redirect(`/t/${tenant.slug}/apps`);
  }

  return (
    <div className="grid min-h-screen grid-cols-1 bg-[var(--surface-paper)] lg:grid-cols-[6fr_4fr]">
      <aside
        aria-hidden
        className="relative hidden flex-col justify-between p-12 lg:flex"
      >
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--ink-tertiary)]">
          —  Established 2026
        </p>

        <div className="page-loaded">
          <h1
            className="font-display text-[clamp(56px,8vw,96px)] leading-[0.92] tracking-[-0.02em] text-[var(--ink-primary)]"
            style={{ fontVariationSettings: "'wght' 700" }}
          >
            Publish
            <br />
            <em className="not-italic" style={{ color: "var(--signal)" }}>
              Anywhere.
            </em>
          </h1>
          <p className="mt-6 max-w-md font-body text-[14px] leading-[1.6] text-[var(--ink-secondary)]">
            Manage App Store Connect and Google Play listings from a single editorial dashboard —
            no console-hopping, no surprises.
          </p>
          <div
            className="mt-6 h-[6px] w-[120px] -rotate-[2deg]"
            style={{ background: "var(--signal)" }}
          />
        </div>

        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
          vol. 1 · self-host edition
        </p>
      </aside>

      <section className="flex items-center justify-center p-6 lg:p-12">
        <div className="w-full max-w-md page-loaded">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--ink-tertiary)]">
            Welcome back
          </p>
          <h2
            className="mb-8 font-display text-[28px] leading-tight tracking-[-0.01em] text-[var(--ink-primary)]"
            style={{ fontVariationSettings: "'wght' 500" }}
          >
            Sign in to your workspace
          </h2>
          <LoginForm />
        </div>
      </section>
    </div>
  );
}
