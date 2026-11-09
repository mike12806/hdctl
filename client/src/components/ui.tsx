import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, type Section } from "../api";
import { useIdle } from "../idle";

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

/** 30_000 -> "30 s", 300_000 -> "5 min". */
export function intervalLabel(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
}

/**
 * "live · as of 20:14:03 · auto-refresh every 30 s": when the data on screen
 * was fetched from its source, and how often the page refreshes itself, so
 * nobody has to wonder. Says so when refreshing is paused because nobody is
 * using the tab (see idle.ts).
 */
export function AsOf({ at, loading, every }: { at: number | null; loading?: boolean; every?: number }) {
  const idle = useIdle();
  const refresh = idle ? (
    <span className="asof-paused" title="No input for 15 minutes, so nothing is being fetched. Move the mouse or press a key to resume.">
      {" "}
      · auto-refresh paused while idle
    </span>
  ) : every ? (
    <span className="muted"> · auto-refresh every {intervalLabel(every)}</span>
  ) : null;
  if (at === null)
    return (
      <span className="asof muted">
        {idle ? "no current data" : loading ? "fetching live data…" : "no data"}
        {refresh}
      </span>
    );
  return (
    <span className="asof" title={new Date(at).toString()}>
      <span className={`dot ${idle ? "dot-muted" : "dot-good"}${loading ? " dot-pulse-soft" : ""}`} aria-hidden /> live · as of {new Date(at).toLocaleTimeString()}
      {refresh}
    </span>
  );
}

/** Shown instead of data while nothing current is available (first load, or data aged out). */
export function Loading({ what }: { what: string }) {
  const idle = useIdle();
  return idle ? (
    <div className="empty">Paused while idle. Move the mouse or press a key to fetch {what} live.</div>
  ) : (
    <div className="empty">Fetching {what} live…</div>
  );
}

/** One part of a page with its own source: its data, or the error that stopped it. Never both. */
export function Block<T>({ title, section, children, actions }: { title: string; section: Section<T>; children: (data: T) => ReactNode; actions?: ReactNode }) {
  return (
    <section className="group">
      <div className="group-head">
        <h2 className="group-title">{title}</h2>
        {actions}
      </div>
      {section.error !== null ? (
        <div className="note note-error small" role="alert">
          <strong>Unavailable</strong>
          <span>{section.error}</span>
        </div>
      ) : section.data !== null ? (
        children(section.data)
      ) : null}
    </section>
  );
}

export function Ok({ children }: { children: ReactNode }) {
  return (
    <div className="note note-ok">
      <span>{children}</span>
    </div>
  );
}

/** A single headline number. */
export function Tile({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: Tone }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className={`tile-value${tone ? ` tone-${tone}` : ""}`}>{value}</span>
      {note && <span className={`tile-note${tone ? ` tone-${tone}` : ""}`}>{note}</span>}
    </div>
  );
}
