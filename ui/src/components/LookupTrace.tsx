import type { GraphResult, SearchTrace } from "../protocol";
import { WORDS, count } from "../lib/knowledgeWords";
import { useStore } from "../store";
import { shortName } from "./GraphCard";

type Line = { step: string; text: React.ReactNode };

const found = (n: number, pool: number) => `${n.toLocaleString()}${n >= pool ? "+" : ""}`; // the pool is a cap: say when it was hit

/** A search_docs call, step by step, in the Knowledge tab's step names: what was searched, what each way found, what was kept. */
export function searchLines(t: SearchTrace): Line[] {
  const where = t.prefix ? <>in <code>{t.prefix}</code></> : <>in {count(t.files, { one: "file", many: "files" })}</>;
  const lines: Line[] = [{
    step: "Chunks",
    text: <>Looked through {count(t.searched, WORDS.snippet)} {where}{t.building ? " (the index was still updating)" : ""}.</>,
  }];
  const ways: React.ReactNode[] = [];
  if (t.keyword_found !== null) ways.push(<span key="k">keyword found <strong>{found(t.keyword_found, t.pool)}</strong></span>);
  if (t.meaning_found !== null) ways.push(<span key="m">meaning found <strong>{found(t.meaning_found, t.pool)}</strong></span>);
  const meaningOff = t.asked !== "keyword" && t.used === "keyword";
  const partly = t.meaning_found !== null && t.embedded < t.searched;
  lines.push({
    step: "Search",
    text: <>
      {ways.reduce<React.ReactNode[]>((a, w, i) => (i ? [...a, ", ", w] : [w]), [])}.
      {meaningOff && <> Search by meaning is off, so only the words were matched.</>}
      {partly && <> Only {t.embedded.toLocaleString()} of {t.searched.toLocaleString()} chunks can be found by meaning yet.</>}
    </>,
  });
  const both = t.keyword_found !== null && t.meaning_found !== null;
  lines.push({
    step: "Result",
    text: t.shown === 0 ? <>Nothing close enough: the agent was told there were no matches.</>
      : <>{both && t.fused != null ? <>Combined {count(t.fused, { one: "candidate", many: "candidates" })} and </> : null}{both ? "kept" : "Kept"} the best{" "}
          <strong>{t.shown.toLocaleString()}</strong>{t.kept != null && t.kept > t.shown ? ` (${t.kept - t.shown} more cut to keep the answer short)` : ""}.
          {t.tests_down ? " Test files counted less." : ""}</>,
  });
  return lines;
}

/** The module or class a dotted code name sits in ("pkg.app" for pkg.app.Store), or "" for a plain name or a file. */
const owner = (name: string) => (name.includes("/") || name.includes(" ") || !name.includes(".") ? "" : name.slice(0, name.lastIndexOf(".")));

/** An explore_graph call, step by step: which name it started from, how far it followed connections, where it stopped. */
export function graphLines(g: GraphResult, asked: string): Line[] {
  const how = g.matched === "exact" ? "by its exact name"
    : g.matched === "ends" ? <>by the end of its name (asked for “{asked}”)</>
    : <>as the closest match for “{asked}”</>;
  const lines: Line[] = [{
    step: "Map",
    text: <>Started from <code title={g.center.name}>{shortName(g.center.name, 200)}</code>{owner(g.center.name) && <> in <code className="lt-owner">{owner(g.center.name)}</code></>} {how}.{g.alternatives.length > 0 && ` ${count(g.alternatives.length, { one: "other name matched", many: "other names matched" })}.`}</>,
  }];
  const hops = g.by_hop ?? [];
  let reached = hops.length;
  while (reached > 1 && hops[reached - 1] === 0) reached--; // steps that found nothing: say why, not "0 more at 3 steps"
  const parts = hops.slice(0, reached).map((n, i) => (i === 0 ? count(n, { one: "direct connection", many: "direct connections" }) : `${n.toLocaleString()} more at ${i + 1} steps`));
  const short = reached < hops.length ? (g.truncated ? ", and hit the limit before going further" : ", and nothing further away") : "";
  lines.push({
    step: "Followed",
    text: hops.length ? <>{parts.join(", then ")}{short}{g.relation ? <>, only “{g.relation}”</> : null}.</> : <>{count(g.edges.length, WORDS.connection)}.</>,
  });
  if (g.truncated) lines.push({ step: "Result", text: <>Stopped at {count(g.nodes.length, WORDS.name)}: there are more than the agent was shown.</> });
  return lines;
}

/** How one lookup went, as a few numbered lines. `id` (a tool call) adds "See in Knowledge". */
export function LookupTrace({ search, graph, asked, id }: { search?: SearchTrace; graph?: GraphResult; asked?: string; id?: string }) {
  const patch = useStore((s) => s.patch);
  const lines = search ? searchLines(search) : graph ? graphLines(graph, asked ?? graph.center.name) : [];
  if (!lines.length) return null;
  return (
    <div className="lookup-trace">
      <ol aria-label="How the agent looked this up">
        {lines.map((l) => (
          <li key={l.step}><span className="lt-step">{l.step}</span><span className="lt-text">{l.text}</span></li>
        ))}
      </ol>
      {id && (
        <button className="btn-text lt-more" onClick={() => patch({ rightTab: "knowledge", rightOpen: true, knowledgeLookup: id })}>
          See in Knowledge
        </button>
      )}
    </div>
  );
}
