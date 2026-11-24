import { useEffect, useMemo, useRef, useState } from "react";
import { uploadAttachment } from "../api";
import { useStore, type PendingFile } from "../store";
import type { Uploaded } from "../protocol";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";

const COMMANDS: { cmd: string; help: string }[] = [
  { cmd: "/new", help: "start a new session" },
  { cmd: "/clear", help: "clear the conversation and start fresh" },
  { cmd: "/plan", help: "plan mode on or off (Shift+Tab)" },
  { cmd: "/goal", help: "work unattended until done" },
  { cmd: "/compact", help: "replace the conversation with a summary" },
  { cmd: "/context", help: "what fills the context window" },
  { cmd: "/index", help: "update the document index (--rebuild, --embed)" },
  { cmd: "/graph", help: "the knowledge graph (build: a model reads the prose)" },
  { cmd: "/model ", help: "switch model" },
  { cmd: "/permissions ", help: "ask | judge | allow" },
  { cmd: "/effort ", help: "low … max, or default" },
  { cmd: "/limit ", help: "compaction limit in tokens" },
  { cmd: "/help", help: "list commands" },
];

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.py,.ts,.tsx,.js,.jsx,.json,.yaml,.yml,.toml,.csv,.sh,.go,.rs,.java,.rb,.c,.h,.cpp,.css,.html,.sql,.txt";
const MAX_PREVIEW_BYTES = 5_000_000;

let fileKey = 0;

function readPreview(file: File): Promise<string | undefined> {
  if (!file.type.startsWith("image/") || file.size > MAX_PREVIEW_BYTES) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file); // a data: URL, which the page's Content-Security-Policy allows for images
  });
}

function size(n: number) {
  return n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.round(n / 1024)} KB` : `${(n / 1_048_576).toFixed(1)} MB`;
}

export function Composer() {
  const [text, setText] = useState("");
  const [pick, setPick] = useState(0);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const running = useStore((s) => s.running);
  const connected = useStore((s) => s.connected);
  const submit = useStore((s) => s.submit);
  const cancel = useStore((s) => s.cancel);
  const draft = useStore((s) => s.draft);
  const patch = useStore((s) => s.patch);
  const info = useStore((s) => s.info);
  const allow = useStore((s) => s.info?.permissions === "allow");
  const plan = useStore((s) => s.info?.plan === true);
  const setMode = useStore((s) => s.setMode);
  const setPlan = useStore((s) => s.setPlan);
  const sessionId = info?.session_id;

  useEffect(() => {
    if (draft === null) return;
    setText(draft);
    patch({ draft: null });
    ref.current?.focus();
  }, [draft, patch]);

  // a new or resumed session drops the files waiting in the box (the server forgets them too)
  useEffect(() => setFiles([]), [sessionId]);

  const matches = useMemo(() => (text.startsWith("/") && !text.includes("\n") ? COMMANDS.filter((c) => c.cmd.startsWith(text.split(" ")[0]) && text.split(" ").length === 1) : []), [text]);

  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 220) + "px";
    }
  }, [text]);
  useEffect(() => setPick(0), [matches.length]);

  const add = (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      const key = `f${++fileKey}`;
      const name = file.name || (file.type.startsWith("image/") ? `pasted-image.${file.type.split("/")[1] ?? "png"}` : "pasted");
      const named = file.name ? file : new File([file], name, { type: file.type });
      setFiles((fs) => [...fs, { key, name, size: file.size }]);
      void readPreview(named).then((preview) => preview && setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, preview } : f))));
      uploadAttachment(named).then(
        (up: Uploaded) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, id: up.id, kind: up.kind, name: up.name } : f))),
        (e: Error) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, error: e.message } : f))),
      );
    }
  };

  const uploading = files.some((f) => !f.id && !f.error);
  const ready = files.filter((f) => f.id && f.kind);
  const hasContent = text.trim().length > 0 || files.some((f) => !f.error);
  const canSend = connected && hasContent;
  const [queued, setQueued] = useState(false); // Enter was pressed while files were still uploading: send when they are done

  const send = () => {
    if (!canSend) return;
    if (uploading) return setQueued(true);
    setQueued(false);
    const sent = submit(text, ready.map((f) => ({ id: f.id!, name: f.name, kind: f.kind!, size: f.size, preview: f.preview })));
    if (sent) {
      setText("");
      setFiles([]);
    }
  };
  useEffect(() => {
    if (queued && !uploading) send();
  }, [queued, uploading]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="composer">
      {allow && (
        <div className="allow-strip" role="status">
          <Icon name="shield-x" size={16} />
          <span>Allow is on: nothing is asked. Commands run as you.</span>
          <button className="btn btn-sm" onClick={() => setMode("ask")}>Switch to Ask</button>
        </div>
      )}
      {plan && (
        <div className="plan-strip" role="status">
          <Icon name="plan" size={16} />
          <span>Plan mode: the agent only reads and searches until you approve its plan.</span>
          <button className="btn btn-sm" onClick={() => setPlan(false)}>Turn off</button>
        </div>
      )}
      {matches.length > 0 && (
        <ul className="palette" role="listbox">
          {matches.map((m, i) => (
            <li key={m.cmd} role="option" aria-selected={i === pick} className={i === pick ? "active" : ""} onMouseDown={(e) => { e.preventDefault(); setText(m.cmd); ref.current?.focus(); }}>
              <code>{m.cmd.trim()}</code> <span>{m.help}</span>
            </li>
          ))}
        </ul>
      )}
      <div
        className={`box ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
          ref.current?.focus();
        }}
      >
        {files.length > 0 && (
          <ul className="pending-files" aria-label="Files to send">
            {files.map((f) => (
              <li key={f.key} className={`file-chip ${f.error ? "bad" : ""} ${f.preview ? "has-thumb" : ""}`} title={f.error ?? f.name}>
                {f.preview ? <img src={f.preview} alt="" /> : <Icon name="file" />}
                <span className="file-name">{f.name}</span>
                {f.error ? <span className="file-meta bad">{f.error}</span>
                  : !f.id ? <Spinner size={12} label="uploading" />
                  : <span className="file-meta">{size(f.size)}</span>}
                <button className="file-x" onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))} aria-label={`Remove ${f.name}`}><Icon name="x" size={12} /></button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={ref}
          id="composer"
          value={text}
          rows={2}
          placeholder={connected ? (running ? "Working… you can type, but sending waits until this turn ends" : plan ? "Describe what to plan, or / for commands" : "Message Mini Harness, or / for commands") : info ? "Can't send while disconnected" : "Connecting…"}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length) {
              e.preventDefault();
              add(pasted);
            }
          }}
          onKeyDown={(e) => {
            if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setPick((p) => (p + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
            } else if (matches.length && e.key === "Tab") {
              e.preventDefault();
              setText(matches[pick].cmd);
            } else if (e.key === "Tab" && e.shiftKey) {
              e.preventDefault();
              setPlan(!plan);
            } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape" && running) {
              cancel();
            }
          }}
          autoFocus
        />
        <div className="cfoot">
          <button className="btn-icon attach" onClick={() => picker.current?.click()} title="Attach images, PDFs or text files (or paste, or drop them here)" aria-label="Attach files">
            <Icon name="paperclip" size={16} />
          </button>
          <input ref={picker} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ""; }} />
          <button className="cmds" onClick={() => { setText("/"); ref.current?.focus(); }} title="Show the commands">/ commands</button>
          <button className={`plan-toggle ${plan ? "on" : ""}`} onClick={() => setPlan(!plan)} aria-pressed={plan} title="Plan mode: read-only until you approve a plan (Shift+Tab)">
            <Icon name="plan" size={12} /> Plan
          </button>
          <span className="spacer" />
          <span className="chint">{running ? "Esc to stop · the turn is dropped" : uploading ? (queued ? "Sends when the files are uploaded…" : "Uploading…") : "Enter to send · Shift+Enter for a new line"}</span>
          {running ? (
            <button className="btn btn-sm stop" onClick={cancel} aria-label="Stop"><Icon name="stop" size={12} /> Stop</button>
          ) : (
            <button className="send" onClick={send} disabled={!canSend} aria-label="Send"><Icon name="send" /></button>
          )}
        </div>
      </div>
    </div>
  );
}
