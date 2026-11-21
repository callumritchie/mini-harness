/** The product's mark: a neutral tile with an "H" (the design keeps the brand out of the accent colour). */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <span className="brand-tile" style={{ width: size, height: size, borderRadius: Math.round(size / 4), fontSize: Math.round(size * 0.55) }} aria-hidden>
      H
    </span>
  );
}
