"use client";

/**
 * URL-driven wrapper around the shared LocaleRail for the Keywords
 * surface. Selection lives in `?locale=…` so it survives tab switches
 * between Opportunities / Tracked / History / Competitors and lets the
 * server pre-render the right slice.
 *
 * Visual parity note: this rail uses the same chip shape and compact
 * spacing as the Metadata rail. The "Pending Push" filter checkbox is
 * intentionally NOT enabled here — that workflow is metadata-specific
 * (the operator filters to locales they edited so they can review
 * before pushing). Keywords editing happens inside the per-locale
 * detail view, so a rail-level filter would be redundant. The state
 * dot on each chip still flags dirty locales visually, which is the
 * same as Metadata's at-a-glance signal.
 *
 * The earlier variant had an extra "All locales" pseudo-entry plus a
 * per-locale opportunities badge; both were removed so every per-app
 * locale picker in the product reads the same way. The opportunities
 * count still lives on the Opportunities surface itself.
 */
import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LocaleStrip, type LocaleStripEntry } from "@/components/shell/LocaleStrip";

export interface LocaleEntry {
  locale: string;
  /** Whether the locale row has unpushed local edits — surfaces the
   *  Pending-Push chip-state dot + lets the "Pending Push" filter
   *  narrow the list to just-edited locales. */
  dirty: boolean;
}

interface Props {
  entries: LocaleEntry[];
  primaryLocale: string;
}

export function KeywordsLocaleRail({
  entries,
  primaryLocale,
}: Props): JSX.Element {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const selected = searchParams?.get("locale") ?? null;

  const handleSelect = useCallback(
    (locale: string | null): void => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (locale === null) params.delete("locale");
      else params.set("locale", locale);
      const qs = params.toString();
      router.push(`${pathname}${qs ? `?${qs}` : ""}`);
    },
    [router, pathname, searchParams],
  );

  // Project consumer-shaped entries into the strip's shape. Only the
  // dirty state surfaces — opportunities counts and other badges live
  // inside the sub-tabs themselves where they're discoverable.
  const stripEntries: LocaleStripEntry[] = entries.map((e) => ({
    locale: e.locale,
    state: e.dirty ? ("dirty" as const) : ("synced" as const),
  }));

  return (
    <LocaleStrip
      entries={stripEntries}
      // Old URLs may still carry `?locale=ALL` — coerce to null so the
      // page falls back to its no-scope default rather than crashing
      // on an unknown locale code.
      selected={selected === "ALL" ? null : selected}
      onSelect={handleSelect}
      primaryLocale={primaryLocale}
      // Keywords surface kept its "All locales" pseudo-entry because
      // the Opportunities tab spans every locale until a scope is
      // chosen — operators want to clear scope quickly.
      allowAll
      allLabel="All locales"
    />
  );
}
