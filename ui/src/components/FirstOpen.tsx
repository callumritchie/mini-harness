import { useEffect, useState } from "react";
import { api } from "../api";
import type { IndexPlan } from "../protocol";
import { count } from "../lib/knowledgeWords";
import { useStore } from "../store";

const mb = (bytes: number) => (bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`);

/** The first time the app opens a folder: what the agent could search, and the choice (everything, choose folders, not now).
 *  Nothing is indexed before an answer. Shown while nobody has chosen; an empty folder is never asked about. */
export function FirstOpen() {
  const status = useStore((s) => s.indexStatus);
  const patch = useStore((s) => s.patch);
  const chooseSearch = useStore((s) => s.chooseSearch);
  const [plan, setPlan] = useState<IndexPlan | null>(null);
  const undecided = Boolean(status?.available && status.selection === null && !status.allowed);
  useEffect(() => {
    if (!undecided) return;
    let live = true;
    api<IndexPlan>("index/plan").then((p) => live && setPlan(p)).catch(() => live && setPlan(null));
    return () => { live = false; };
  }, [undecided]);
  if (!undecided || !plan || plan.empty || plan.chosen) return null;
  const leftOut = [plan.gitignored ? `${plan.gitignored.toLocaleString()} in .gitignore` : "", plan.left_out ? `${plan.left_out.toLocaleString()} images, binaries or secret files` : ""]
    .filter(Boolean).join(" and ");
  return (
    <section className="first-open" aria-labelledby="fo-h">
      <h2 id="fo-h">Let the agent search this folder?</h2>
      <p className="fo-what">
        <strong>{count(plan.files, { one: "text file", many: "text files" })}</strong> · {mb(plan.bytes)} · about {count(plan.chunks, { one: "chunk", many: "chunks" })}
        {plan.capped && " (stopped counting at 20,000 files)"}
      </p>
      <p className="fo-sub">The agent can then find things by keyword and by meaning, and follow how the code connects. {leftOut && `Left out: ${leftOut}.`}</p>
      <div className="fo-actions">
        <button className="btn btn-primary" onClick={() => chooseSearch({})}>Search everything</button>
        <button className="btn" onClick={() => patch({ rightOpen: true, rightTab: "files", filesChoose: true, selectedFile: null })}>Choose folders…</button>
        <button className="btn-text" onClick={() => chooseSearch({ off: true })}>Not now</button>
      </div>
      <p className="fo-note">Everything stays on this computer. The first time, search by meaning downloads a 130 MB model.</p>
    </section>
  );
}
