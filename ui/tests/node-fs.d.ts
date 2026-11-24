// The one Node API the tests use (vitest runs in Node); the project has no @types/node.
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}
