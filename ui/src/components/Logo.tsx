/** A small neutral mark: a harness strap, two rails and a cross-bar. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 4v16M17 4v16M7 9h10M7 15h10" />
    </svg>
  );
}
