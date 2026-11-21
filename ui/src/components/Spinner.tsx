/** The design's spinner: a quiet track with an accent arc. With a label it is announced; without one it is decoration. */
export function Spinner({ size = 14, label }: { size?: number; label?: string }) {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 16 16" fill="none" strokeWidth="2"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      <circle cx="8" cy="8" r="5.5" stroke="var(--line-strong)" />
      <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" stroke="var(--accent)" strokeLinecap="round" />
    </svg>
  );
}
