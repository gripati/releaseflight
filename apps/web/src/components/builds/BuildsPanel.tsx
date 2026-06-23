"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Package, RefreshCcw, Rocket, Upload } from "lucide-react";
import { Button, Card, Spinner, Stamp, StateDot, cn } from "@marquee/ui";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";
import { AabUploadDialog } from "./AabUploadDialog";
import { TrackAssignDialog } from "./TrackAssignDialog";

interface Props {
  appId: string;
  platform: "IOS" | "ANDROID";
  bundleId: string;
  versionString: string | null;
  versionId: string | null;
}

interface AppleBuild {
  id: string;
  version: string;
  buildNumber: string;
  uploadedDate: string;
  state: string;
}

interface GoogleBundle {
  versionCode: number;
  sha256: string;
  sha1: string | null;
}

interface GoogleTrack {
  track: string;
  releases: {
    name?: string;
    versionCodes: string[];
    status: string;
    userFraction?: number;
  }[];
}

interface IosData {
  platform: "IOS";
  builds: AppleBuild[];
}
interface AndroidData {
  platform: "ANDROID";
  bundles: GoogleBundle[];
  tracks: GoogleTrack[];
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60).toString()}m ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600).toString()}h ago`;
  return `${Math.round(sec / 86_400).toString()}d ago`;
}

function stateStyle(state: string): {
  dot: "synced" | "syncing" | "error";
  variant: "success" | "info" | "danger" | "warning";
} {
  if (state === "VALID") return { dot: "synced", variant: "success" };
  if (state === "PROCESSING") return { dot: "syncing", variant: "info" };
  if (state === "INVALID" || state === "FAILED") return { dot: "error", variant: "danger" };
  return { dot: "syncing", variant: "warning" };
}

export function BuildsPanel(props: Props): JSX.Element {
  const router = useRouter();
  const [data, setData] = useState<IosData | AndroidData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, refresh] = useTransition();
  const [showUpload, setShowUpload] = useState(false);
  const [assignTarget, setAssignTarget] = useState<{ versionCode: number } | null>(null);

  function reload(): void {
    refresh(() => {
      void (async () => {
        const res = await api<IosData | AndroidData>(`/api/v1/apps/${props.appId}/builds`);
        setLoading(false);
        if (res.ok) setData(res.data);
        else toast.error(`Failed to load builds: ${res.message}`);
      })();
    });
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.appId]);

  return (
    <div className="page-loaded space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b-[0.5px] border-[var(--stroke-default)] pb-4">
        <div>
          <p className="font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
            {props.platform} · {props.bundleId}
            {props.versionString ? ` · v${props.versionString}` : ""}
          </p>
          <h2
            className="font-display mt-1 text-2xl tracking-[-0.01em]"
            style={{ fontVariationSettings: "'wght' 500" }}
          >
            Release
          </h2>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="md" onClick={reload} disabled={refreshing}>
            {refreshing ? <Spinner size={12} /> : <RefreshCcw size={14} />} Refresh
          </Button>
          {props.platform === "ANDROID" && (
            <Button variant="primary" size="md" onClick={() => setShowUpload(true)}>
              <Upload size={14} /> Upload AAB
            </Button>
          )}
        </div>
      </div>

      {props.platform === "IOS" && (
        <Card className="bg-[var(--surface-sunken)] text-[12px]">
          <p className="font-body text-[var(--ink-secondary)]">
            iOS builds come from Xcode / Transporter — there's no public REST upload. After your
            build appears here, attach it to the latest version on the <strong>Submission</strong>{" "}
            tab and we'll submit it for review.
          </p>
        </Card>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner size={16} />
        </div>
      ) : data?.platform === "IOS" ? (
        <IosBuilds data={data} versionId={props.versionId} />
      ) : data?.platform === "ANDROID" ? (
        <AndroidBuilds
          data={data}
          onAssignBundle={(versionCode) => setAssignTarget({ versionCode })}
        />
      ) : null}

      <AabUploadDialog
        open={showUpload}
        onClose={() => setShowUpload(false)}
        appId={props.appId}
        onUploaded={() => {
          reload();
          router.refresh();
        }}
      />
      {assignTarget && (
        <TrackAssignDialog
          open={true}
          onClose={() => setAssignTarget(null)}
          appId={props.appId}
          versionCode={assignTarget.versionCode}
          onAssigned={() => {
            setAssignTarget(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function IosBuilds({ data, versionId }: { data: IosData; versionId: string | null }): JSX.Element {
  if (data.builds.length === 0) {
    return (
      <Card className="text-center">
        <Package size={28} className="mx-auto text-[var(--ink-quaternary)]" />
        <h3 className="font-display mt-4 text-xl" style={{ fontVariationSettings: "'wght' 500" }}>
          No builds yet
        </h3>
        <p className="font-body mt-2 text-[13px] text-[var(--ink-secondary)]">
          Upload an IPA from Xcode → Window → Organizer, or use{" "}
          <code className="font-mono text-[11px]">xcrun altool / Transporter</code>.
        </p>
      </Card>
    );
  }
  return (
    <Card className="divide-y divide-[var(--stroke-default)] p-0">
      {data.builds.map((b) => {
        const style = stateStyle(b.state);
        return (
          <div
            key={b.id}
            className="grid grid-cols-[24px_120px_1fr_140px_120px] items-center gap-3 px-4 py-3"
          >
            <StateDot state={style.dot} />
            <span className="font-mono text-[12px] text-[var(--ink-primary)]">
              v{b.version || "?"} · #{b.buildNumber}
            </span>
            <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
              uploaded {relTime(b.uploadedDate)}
            </span>
            <Stamp variant={style.variant}>{b.state}</Stamp>
            <Button
              variant="ghost"
              size="sm"
              disabled={!versionId || b.state !== "VALID"}
              title={
                !versionId
                  ? "Pull metadata first to find the version"
                  : b.state !== "VALID"
                    ? `Build state is ${b.state} — only VALID builds can be submitted`
                    : "Go to the Release tab to submit this version for review"
              }
              onClick={() => {
                toast.info("Open the Release tab", {
                  description: "Choose this build there + run the pre-submission checks.",
                });
              }}
            >
              <Rocket size={12} /> Submit
            </Button>
          </div>
        );
      })}
    </Card>
  );
}

function AndroidBuilds({
  data,
  onAssignBundle,
}: {
  data: AndroidData;
  onAssignBundle: (versionCode: number) => void;
}): JSX.Element {
  return (
    <>
      <section>
        <h3 className="mb-2 font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
          Uploaded bundles · {data.bundles.length}
        </h3>
        {data.bundles.length === 0 ? (
          <Card className="text-center">
            <Package size={28} className="mx-auto text-[var(--ink-quaternary)]" />
            <h4 className="font-display mt-3 text-lg">No bundles yet</h4>
            <p className="font-body mt-1 text-[12px] text-[var(--ink-secondary)]">
              Drop an .aab to start a release.
            </p>
          </Card>
        ) : (
          <Card className="divide-y divide-[var(--stroke-default)] p-0">
            {data.bundles
              .slice()
              .sort((a, b) => b.versionCode - a.versionCode)
              .map((b) => (
                <div key={b.versionCode} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="font-mono text-[12px] text-[var(--ink-primary)]">
                    versionCode {b.versionCode}
                  </span>
                  <span
                    className="flex-1 truncate font-mono text-[10px] text-[var(--ink-tertiary)]"
                    title={b.sha256}
                  >
                    sha256 {b.sha256.slice(0, 12)}…
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onAssignBundle(b.versionCode)}
                  >
                    Assign to track →
                  </Button>
                </div>
              ))}
          </Card>
        )}
      </section>

      <section>
        <h3 className="mb-2 font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
          Tracks · {data.tracks.length}
        </h3>
        <Card className="divide-y divide-[var(--stroke-default)] p-0">
          {data.tracks.length === 0 && (
            <p className="font-body px-4 py-6 text-center text-[12px] text-[var(--ink-tertiary)]">
              No tracks yet. Assign a bundle to internal / alpha / beta / production above.
            </p>
          )}
          {data.tracks.map((t) => (
            <div key={t.track} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <Stamp
                  variant={
                    t.track === "production"
                      ? "default"
                      : t.track === "beta"
                        ? "info"
                        : t.track === "alpha"
                          ? "warning"
                          : "success"
                  }
                >
                  {t.track}
                </Stamp>
                <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">
                  {t.releases.length} release{t.releases.length === 1 ? "" : "s"}
                </span>
              </div>
              {t.releases.length > 0 && (
                <ul className="mt-2 space-y-1 font-mono text-[11px]">
                  {t.releases.map((r, idx) => (
                    <li
                      key={`${t.track}-${idx.toString()}`}
                      className="flex flex-wrap items-center gap-2 text-[var(--ink-secondary)]"
                    >
                      <span
                        className={cn(
                          "tracking-[0.08em] uppercase",
                          r.status === "completed" && "text-[var(--status-success)]",
                          r.status === "inProgress" && "text-[var(--status-info)]",
                          r.status === "halted" && "text-[var(--status-danger)]",
                        )}
                      >
                        {r.status}
                      </span>
                      {r.userFraction !== undefined && (
                        <span>· {(r.userFraction * 100).toFixed(1)}%</span>
                      )}
                      <span>· version codes {r.versionCodes.join(", ")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </Card>
      </section>
    </>
  );
}
