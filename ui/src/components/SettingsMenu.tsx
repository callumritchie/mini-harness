import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { formatCost, formatTokens } from "../lib/lang";

const OTHER = "__other__";

/** Model, effort and the compaction limit, in one popover so the top bar stays a single row. */
export function SettingsMenu({ context, pct }: { context: number; pct: number }) {
  const total = useStore((s) => s.totalCost);
  const info = useStore((s) => s.info);
  const running = useStore((s) => s.running);
  const setModel = useStore((s) => s.setModel);
  const setEffort = useStore((s) => s.setEffort);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (!info) return null;
  const note = info.models.find((m) => m.id === info.model)?.note;
  return (
    <div className="settings" ref={box}>
      <button className="setbtn" onClick={() => setOpen(!open)} aria-label="Settings" aria-expanded={open}
        title={`${info.model}. Context: ${context.toLocaleString()} of ${info.limit.toLocaleString()} tokens in the last request. Click for model and effort.`}>
        <span className="model">{info.model}</span>
        <span className="dot d1" aria-hidden>|</span>
        <span className="cost" title={total?.note ?? "Cost of this session"}>
          {!info.price_known && !total?.usd ? "cost unknown" : formatCost(total?.usd ?? 0, total?.complete ?? true)}
        </span>
        <span className="dot d2" aria-hidden>|</span>
        <span className="mini-bar d2" aria-hidden><span className={pct >= 80 ? "high" : ""} style={{ width: `${pct}%` }} /></span>
        <span className="ctx">{formatTokens(context)} / {formatTokens(info.limit)}</span>
      </button>
      {open && (
        <div className="pop" role="dialog" aria-label="Settings">
          <label>Model
            <select value={info.model} disabled={running}
              onChange={(e) => {
                if (e.target.value !== OTHER) return setModel(e.target.value);
                const name = window.prompt("Model id (for example claude-sonnet-4-6):")?.trim();
                if (name && name !== info.model) setModel(name);
              }}>
              {!info.models.some((m) => m.id === info.model) && <option value={info.model}>{info.model}</option>}
              {info.models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
              <option value={OTHER}>Other…</option>
            </select>
            {note && <span className="hint">{note}</span>}
          </label>
          <label>Effort
            <select value={info.effort ?? "default"} onChange={(e) => setEffort(e.target.value === "default" ? null : e.target.value)}>
              <option value="default">default</option>
              {info.efforts.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
            <span className="hint">How hard the model thinks. Only some models use it.</span>
          </label>
        </div>
      )}
    </div>
  );
}
