import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api";

export type Tone = "good" | "warn" | "bad" | "info" | "muted";

export function Pill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Dot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return <span className={`dot dot-${tone}${pulse ? " dot-pulse" : ""}`} aria-hidden />;
}

/** A small horizontal usage bar (CPU, memory). */
export function Meter({ value, label }: { value: number; label: string }) {
  const v = Math.max(0, Math.min(1, value));
  const tone: Tone = v > 0.9 ? "bad" : v > 0.75 ? "warn" : "good";
  return (
    <div className="meter" title={label}>
      <div className={`meter-fill meter-${tone}`} style={{ width: `${v * 100}%` }} />
      <span className="meter-label">{label}</span>
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className={`note ${e?.setup ? "note-setup" : "note-error"}`} role="alert">
      <strong>{e?.setup ? "Not set up yet" : e?.status ? `Error ${e.status}` : "Error"}</strong>
      <span>{msg}</span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/**
 * Confirmation for anything that changes the lab. Shows what will happen,
 * runs the action, and keeps the dialog open with the error if it fails.
 */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) {
      setError(null);
      d.showModal();
    } else if (!props.open && d.open) d.close();
  }, [props.open]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm();
      props.onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="dialog" onClose={props.onClose} onCancel={() => !busy && props.onClose()}>
      <h2>{props.title}</h2>
      <div className="dialog-body">{props.children}</div>
      <ErrorNote error={error} />
      <div className="dialog-actions">
        <button className="btn" onClick={props.onClose} disabled={busy}>
          Cancel
        </button>
        <button className={`btn ${props.danger ? "btn-danger" : "btn-primary"}`} onClick={confirm} disabled={busy} autoFocus>
          {busy ? "Working…" : props.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      <div className="page-actions">{children}</div>
    </header>
  );
}

/** "live · as of 20:14:03": when the data on screen was fetched from its source. */
export function AsOf({ at, loading }: { at: number | null; loading?: boolean }) {
  if (at === null) return <span className="asof muted">{loading ? "fetching live data…" : "no data"}</span>;
  return (
    <span className="asof" title={new Date(at).toString()}>
      <span className={`dot dot-good${loading ? " dot-pulse-soft" : ""}`} aria-hidden /> live · as of {new Date(at).toLocaleTimeString()}
    </span>
  );
}

/** Shown instead of data while nothing current is available (first load, or data aged out). */
export function Loading({ what }: { what: string }) {
  return <div className="empty">Fetching {what} live…</div>;
}
