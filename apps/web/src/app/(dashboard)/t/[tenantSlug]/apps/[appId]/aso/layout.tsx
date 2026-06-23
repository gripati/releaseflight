/**
 * Legacy /aso layout — the sub-tabs are gone under the new IA. The
 * /aso/* routes still resolve so old bookmarks can hit them, but they
 * all redirect away from this segment before rendering, so this
 * layout is effectively a passthrough kept only so the directory has
 * a default export.
 */
interface LayoutProps {
  children: React.ReactNode;
}

export default function AsoLayout({ children }: LayoutProps): JSX.Element {
  return <>{children}</>;
}
