import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The motion rules in DESIGN.md ("Web UI rules" › Motion), as a check: transitions name their properties, never animate layout,
// never use ease-in, and stay inside 300ms (drawers and dialogs included). Looping keyframe animations (spinner, breathe) are not
// transitions and are not checked here.
const css = readFileSync("src/styles.css", "utf8").replace( // vitest runs from ui/
  /\/\*[\s\S]*?\*\//g, "");
const tokens = Object.fromEntries([...css.matchAll(/--(dur-[a-z]+):\s*(\d+)ms/g)].map((m) => [m[1], Number(m[2])]));
const LAYOUT = /^(width|height|min-|max-|margin|padding|top|left|right|bottom|inset|border-width|font-size|gap)/;

const declarations = [...css.matchAll(/(?<![-\w])(transition(?:-property|-duration|-timing-function)?)\s*:\s*([^;}]+)/g)].map((m) => ({ prop: m[1], value: m[2].trim() }));

const ms = (v: string): number[] =>
  [...v.matchAll(/var\(--(dur-[a-z]+)\)|(\d*\.?\d+)(ms|s)\b/g)].map((m) => (m[1] ? tokens[m[1]] ?? NaN : Number(m[2]) * (m[3] === "s" ? 1000 : 1)));

describe("motion rules", () => {
  it("finds the transitions to check", () => {
    expect(declarations.length).toBeGreaterThan(10);
    expect(tokens["dur-drawer"]).toBeDefined();
  });

  it("never uses transition: all", () => {
    const bad = declarations.filter((d) => (d.prop === "transition" || d.prop === "transition-property") && /(^|,)\s*all\b/.test(d.value));
    expect(bad).toEqual([]);
  });

  it("never transitions a layout property", () => {
    const bad = declarations
      .filter((d) => d.prop === "transition" || d.prop === "transition-property")
      .flatMap((d) => d.value.split(",").map((part: string) => part.trim().split(/\s+/)[0]))
      .filter((p) => LAYOUT.test(p));
    expect(bad).toEqual([]);
  });

  it("never uses ease-in", () => {
    expect(css.match(/\bease-in\b(?!-out)/g) ?? []).toEqual([]);
  });

  it("keeps every transition within 300ms", () => {
    const bad = declarations
      .filter((d) => d.prop === "transition" || d.prop === "transition-duration")
      .flatMap((d) => ms(d.value).map((n) => ({ ...d, n })))
      .filter((d) => !(d.n <= 300));
    expect(bad).toEqual([]);
  });
});
