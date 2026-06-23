"use client";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCcw, Search, ShieldAlert, Check } from "lucide-react";
import { Button, Input, Label, Spinner, cn } from "@marquee/ui";
import { Sheet } from "@/components/feedback/Sheet";
import { AppleLogo, GooglePlayLogo, type BrandIconProps } from "@/components/icons/BrandIcons";
import { api } from "@/lib/apiClient";

type Platform = "IOS" | "ANDROID";

interface CredentialOption {
  id: string;
  name: string;
  kind: "APPLE" | "GOOGLE";
}

interface DiscoveredApp {
  storeAppId: string;
  bundleId: string;
  name: string;
  sku: string;
  primaryLocale: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  tenantSlug: string;
}

/**
 * Connect-app wizard — a clean, two-step flow:
 *   1. Platform  — Apple (iOS) or Google Play (Android).
 *   2. Pick app  — the credential is shown inline as a "source" (auto-selected;
 *      switchable via a compact selector only when there's more than one), then
 *      iOS lists the discovered apps and Android takes a package name. No third
 *      "choose a credential" step.
 */
export function ConnectAppWizard({ open, onClose, tenantSlug }: Props): JSX.Element {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [credentials, setCredentials] = useState<CredentialOption[]>([]);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredApp[] | null>(null);
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [manualBundle, setManualBundle] = useState("");
  const [manualName, setManualName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isDiscovering, setIsDiscovering] = useState(false);

  useEffect(() => {
    if (!open) return;
    void api<{ credentials: CredentialOption[] }>("/api/v1/credentials").then((r) => {
      if (r.ok) setCredentials(r.data.credentials);
    });
  }, [open]);

  function reset(): void {
    setStep(1);
    setPlatform(null);
    setCredentialId(null);
    setDiscovered(null);
    setSelectedStoreId(null);
    setQuery("");
    setManualBundle("");
    setManualName("");
    setError(null);
  }
  function close(): void {
    reset();
    onClose();
  }

  function credentialsFor(p: Platform): CredentialOption[] {
    return credentials.filter((c) => (p === "IOS" ? c.kind === "APPLE" : c.kind === "GOOGLE"));
  }

  function pickPlatform(p: Platform): void {
    setPlatform(p);
    setError(null);
    setDiscovered(null);
    setSelectedStoreId(null);
    setQuery("");
    // Auto-select the first matching credential — no separate picker step.
    const id = credentialsFor(p)[0]?.id ?? null;
    setCredentialId(id);
    setStep(2);
    if (p === "IOS" && id) void discoverApps(id);
  }

  function changeCredential(id: string): void {
    setCredentialId(id);
    setSelectedStoreId(null);
    setError(null);
    if (platform === "IOS") {
      setDiscovered(null);
      void discoverApps(id);
    }
  }

  async function discoverApps(credId: string): Promise<void> {
    setIsDiscovering(true);
    setError(null);
    const res = await api<{ apps: DiscoveredApp[] }>("/api/v1/apps/discover", {
      method: "POST",
      body: { credentialId: credId, platform: "IOS" },
    });
    setIsDiscovering(false);
    if (!res.ok) {
      setError(res.message);
      setDiscovered([]);
      return;
    }
    setDiscovered(res.data.apps);
  }

  function connect(): void {
    if (!platform || !credentialId) return;
    setError(null);
    startTransition(() => {
      void (async () => {
        let payload: { platform: Platform; bundleId: string; appName: string; credentialId: string; storeAppId?: string };
        if (platform === "IOS") {
          const picked = discovered?.find((d) => d.storeAppId === selectedStoreId);
          if (!picked) {
            setError("Select an app to connect");
            return;
          }
          payload = {
            platform,
            bundleId: picked.bundleId,
            appName: picked.name,
            credentialId,
            storeAppId: picked.storeAppId,
          };
        } else {
          if (!manualBundle || !manualName) {
            setError("Package name and app name are required");
            return;
          }
          payload = {
            platform,
            bundleId: manualBundle.trim(),
            appName: manualName.trim(),
            credentialId,
          };
        }
        const res = await api<{ id: string }>("/api/v1/apps", { method: "POST", body: payload });
        if (!res.ok) {
          setError(res.message);
          return;
        }
        // Land on the new app with ?sync=1 so <AppSyncIndicator> auto-fetches
        // metadata + screenshots + previews and shows live progress.
        router.push(`/t/${tenantSlug}/apps/${res.data.id}/pulse?sync=1`);
        router.refresh();
      })();
    });
  }

  const matchingCredentials = platform ? credentialsFor(platform) : [];
  const hasCredentialChoice = matchingCredentials.length > 1;
  const activeCred = credentials.find((c) => c.id === credentialId) ?? null;
  const BrandFor = platform === "IOS" ? AppleLogo : GooglePlayLogo;

  const filtered = useMemo(() => {
    if (!discovered) return [];
    const q = query.trim().toLowerCase();
    if (!q) return discovered;
    return discovered.filter(
      (d) => d.name.toLowerCase().includes(q) || d.bundleId.toLowerCase().includes(q),
    );
  }, [discovered, query]);

  return (
    <Sheet open={open} onClose={close} title="Connect an app" subtitle={`Step ${step.toString()} of 2`} width={640}>
      {/* Progress — two segments */}
      <div className="mb-7 flex items-center gap-2">
        {[1, 2].map((n) => (
          <span
            key={n}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors",
              step >= n ? "bg-[var(--signal)]" : "bg-[var(--stroke-default)]",
            )}
          />
        ))}
      </div>

      {/* ── Step 1 — Platform ─────────────────────────────────────────── */}
      {step === 1 && (
        <section>
          <p className="mb-4 font-body text-[13px] text-[var(--ink-secondary)]">
            Which store is this app on? We'll connect it with your saved credential.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <PlatformCard
              Icon={AppleLogo}
              title="iOS"
              subtitle="App Store Connect"
              detail=".p8 key + Issuer ID"
              onClick={() => pickPlatform("IOS")}
            />
            <PlatformCard
              Icon={GooglePlayLogo}
              title="Android"
              subtitle="Google Play"
              detail="Service-account JSON"
              onClick={() => pickPlatform("ANDROID")}
            />
          </div>
        </section>
      )}

      {/* ── Step 2 — Pick the app ─────────────────────────────────────── */}
      {step === 2 && platform && (
        <section className="space-y-5">
          {matchingCredentials.length === 0 ? (
            <MissingCredential
              platform={platform}
              onBack={() => setStep(1)}
              onGoToCredentials={() => router.push(`/t/${tenantSlug}/credentials`)}
            />
          ) : (
            <>
              {/* Source — which credential we'll connect through */}
              <div className="flex items-center gap-3 rounded-[var(--radius)] border border-[var(--stroke-default)] bg-[var(--surface-tinted)] px-4 py-3">
                <BrandFor size={20} className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-body text-[13px] font-medium text-[var(--ink-primary)]">
                    {activeCred?.name ?? "—"}
                  </div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--ink-tertiary)]">
                    {platform === "IOS" ? "App Store Connect" : "Google Play"}
                  </div>
                </div>
                {hasCredentialChoice && (
                  <select
                    aria-label="Credential"
                    value={credentialId ?? ""}
                    onChange={(e) => changeCredential(e.target.value)}
                    className="rounded-[var(--radius-xs)] border border-[var(--stroke-default)] bg-[var(--surface-paper)] px-2 py-1.5 font-body text-[12px] text-[var(--ink-secondary)]"
                  >
                    {matchingCredentials.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {platform === "IOS" ? (
                <IosAppPicker
                  isDiscovering={isDiscovering}
                  apps={filtered}
                  total={discovered?.length ?? 0}
                  query={query}
                  setQuery={setQuery}
                  selectedStoreId={selectedStoreId}
                  onSelect={setSelectedStoreId}
                  onRefresh={() => credentialId && void discoverApps(credentialId)}
                  error={error}
                />
              ) : (
                <AndroidAppForm
                  bundle={manualBundle}
                  name={manualName}
                  setBundle={setManualBundle}
                  setName={setManualName}
                  error={error}
                />
              )}

              <div className="flex items-center justify-between gap-2 pt-1">
                <Button variant="ghost" onClick={() => setStep(1)} disabled={isPending}>
                  ← Back
                </Button>
                <Button
                  variant="primary"
                  onClick={connect}
                  disabled={
                    isPending ||
                    (platform === "IOS" ? !selectedStoreId : !manualBundle || !manualName)
                  }
                >
                  {isPending ? <Spinner size={12} /> : "Connect →"}
                </Button>
              </div>
            </>
          )}
        </section>
      )}
    </Sheet>
  );
}

/* ── Sub-components ──────────────────────────────────────────────────── */

function PlatformCard({
  Icon,
  title,
  subtitle,
  detail,
  onClick,
}: {
  Icon: (props: BrandIconProps) => JSX.Element;
  title: string;
  subtitle: string;
  detail: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex flex-col items-start gap-4 rounded-[var(--radius)] border border-[var(--stroke-default)] p-6 text-left",
        "transition-all hover:border-[var(--signal)] hover:bg-[var(--surface-tinted)] hover:-translate-y-px hover:shadow-[var(--shadow-elevated)]",
      )}
    >
      <Icon size={28} />
      <div>
        <div
          className="font-display text-xl leading-tight"
          style={{ fontVariationSettings: "'wght' 500" }}
        >
          {title}
        </div>
        <div className="mt-0.5 font-body text-[13px] text-[var(--ink-secondary)]">{subtitle}</div>
      </div>
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--ink-tertiary)]">
        {detail}
      </div>
    </button>
  );
}

function IosAppPicker({
  isDiscovering,
  apps,
  total,
  query,
  setQuery,
  selectedStoreId,
  onSelect,
  onRefresh,
  error,
}: {
  isDiscovering: boolean;
  apps: DiscoveredApp[];
  total: number;
  query: string;
  setQuery: (v: string) => void;
  selectedStoreId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  error: string | null;
}): JSX.Element {
  if (isDiscovering) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-14">
        <Spinner size={18} />
        <span className="font-body text-[13px] text-[var(--ink-secondary)]">
          Loading apps from App Store Connect…
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
          {total} {total === 1 ? "app" : "apps"} found
        </span>
        <button
          type="button"
          onClick={onRefresh}
          className="flex items-center gap-1.5 font-mono text-[11px] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
        >
          <RefreshCcw size={11} /> Refresh
        </button>
      </div>

      {total > 6 && (
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ink-tertiary)]"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps…"
            className="pl-9"
          />
        </div>
      )}

      {error ? (
        <p className="rounded-[var(--radius-xs)] bg-[var(--status-danger-tint)] px-3 py-2.5 font-body text-[12px] text-[var(--status-danger)]">
          {error}
        </p>
      ) : total === 0 ? (
        <p className="rounded-[var(--radius)] border border-dashed border-[var(--stroke-default)] bg-[var(--surface-sunken)] p-8 text-center font-body text-[13px] text-[var(--ink-tertiary)]">
          No apps on this App Store Connect account yet.
        </p>
      ) : (
        <ul className="flex max-h-[360px] flex-col gap-2 overflow-y-auto pr-0.5">
          {apps.map((d) => {
            const active = selectedStoreId === d.storeAppId;
            return (
              <li key={d.storeAppId}>
                <button
                  type="button"
                  onClick={() => onSelect(d.storeAppId)}
                  aria-pressed={active}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-[var(--radius-xs)] border p-3 text-left transition-colors",
                    active
                      ? "border-[var(--signal)] bg-[var(--signal-tint)]"
                      : "border-[var(--stroke-default)] hover:bg-[var(--surface-tinted)]",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-body text-[13px] text-[var(--ink-primary)]">
                      {d.name}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-[var(--ink-tertiary)]">
                      {d.bundleId} · {d.primaryLocale}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors",
                      active
                        ? "border-[var(--signal)] bg-[var(--signal)] text-[var(--signal-on)]"
                        : "border-[var(--stroke-default)]",
                    )}
                  >
                    {active && <Check size={12} strokeWidth={3} />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AndroidAppForm({
  bundle,
  name,
  setBundle,
  setName,
  error,
}: {
  bundle: string;
  name: string;
  setBundle: (v: string) => void;
  setName: (v: string) => void;
  error: string | null;
}): JSX.Element {
  return (
    <div className="space-y-4">
      <p className="rounded-[var(--radius-xs)] bg-[var(--status-info-tint)] px-3 py-2.5 font-body text-[12px] text-[var(--status-info)]">
        Google Play has no list-apps API, so enter the package name — we verify it on the first
        metadata fetch.
      </p>
      <div>
        <Label htmlFor="bundle">Package name</Label>
        <Input
          id="bundle"
          value={bundle}
          onChange={(e) => setBundle(e.target.value.toLowerCase())}
          placeholder="com.gripati.cyberclash"
          className="mt-1.5 font-mono"
          autoFocus
        />
      </div>
      <div>
        <Label htmlFor="name">App display name</Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Cyber Clash"
          className="mt-1.5"
        />
      </div>
      {error && (
        <p className="rounded-[var(--radius-xs)] bg-[var(--status-danger-tint)] px-3 py-2.5 font-body text-[12px] text-[var(--status-danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

function MissingCredential({
  platform,
  onBack,
  onGoToCredentials,
}: {
  platform: Platform;
  onBack: () => void;
  onGoToCredentials: () => void;
}): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-[var(--radius)] border border-[var(--stroke-default)] bg-[var(--status-warning-tint)] p-4">
        <ShieldAlert size={18} className="mt-0.5 shrink-0 text-[var(--status-warning)]" />
        <div className="font-body text-[13px] text-[var(--ink-secondary)]">
          No {platform === "IOS" ? "Apple" : "Google Play"} credential yet. Add one in Credentials,
          then come back to connect your app.
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={onBack}>
          ← Back
        </Button>
        <Button variant="primary" onClick={onGoToCredentials}>
          Go to Credentials →
        </Button>
      </div>
    </div>
  );
}
