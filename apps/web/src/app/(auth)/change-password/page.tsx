import { redirect } from "next/navigation";
import { prismaUnscoped } from "@marquee/db";
import { getSessionFromCookie } from "@/lib/session";
import { ChangePasswordForm } from "./ChangePasswordForm";

export const metadata = { title: "Set your password" };
export const dynamic = "force-dynamic";

export default async function ChangePasswordPage(): Promise<JSX.Element> {
  const session = await getSessionFromCookie();
  if (!session) redirect("/login");
  const user = await prismaUnscoped.user.findUnique({
    where: { id: session.userId },
    select: { mustChangePassword: true },
  });

  const forced = user?.mustChangePassword ?? false;

  return (
    <div className="mx-auto min-h-screen max-w-md px-6 py-16 page-loaded">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--ink-tertiary)]">
        ━━━ SECURITY ━━━
      </p>
      <h1
        className="font-display text-[40px] leading-[1.05] tracking-[-0.01em]"
        style={{ fontVariationSettings: "'wght' 600" }}
      >
        {forced ? (
          <>
            Set your{" "}
            <em className="not-italic font-bold" style={{ color: "var(--signal)" }}>
              password.
            </em>
          </>
        ) : (
          <>
            Change{" "}
            <em className="not-italic font-bold" style={{ color: "var(--signal)" }}>
              password.
            </em>
          </>
        )}
      </h1>
      <p className="mt-4 font-body text-[14px] leading-[1.6] text-[var(--ink-secondary)]">
        {forced
          ? "Your account was created by an administrator with a temporary password. Choose your own password to continue."
          : "Enter your current password and pick a new one."}
      </p>

      <ChangePasswordForm forced={forced} />
    </div>
  );
}
