import type { Uploaded } from "./protocol";

const KEY = "mini-harness-token";

/** The token from the address the server printed (?token=...), remembered for this tab and removed from the address bar. */
export function getToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    try {
      sessionStorage.setItem(KEY, fromUrl);
    } catch {
      /* private mode: the token then only lives in this page load */
    }
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    memory = fromUrl;
    return fromUrl;
  }
  if (memory) return memory;
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

let memory: string | null = null;

export async function api<T>(path: string, params?: Record<string, string>): Promise<T> {
  const token = getToken();
  const query = params ? "?" + new URLSearchParams(params).toString() : "";
  return read<T>(await fetch(`/api/${path}${query}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }));
}

/** Put one file on the server for the next message. It answers with the id the message refers to, or says why it can't be attached. */
export async function uploadAttachment(file: File): Promise<Uploaded> {
  const token = getToken();
  const headers: Record<string, string> = { "X-Filename": encodeURIComponent(file.name || "pasted"), "Content-Type": file.type || "application/octet-stream" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return read<Uploaded>(await fetch("/api/attachments", { method: "POST", headers, body: file }));
}

async function read<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.detail ?? body.error ?? message;
    } catch {
      /* not json */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}
