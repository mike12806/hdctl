import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, post, send, type Device, type Devices, type FeedStatus, type IncidentFeed, type NotifyIncident as Incident, type Mute, type NotifySeverity, type NotifySource, type PushResult } from "../api";
import { ago, time } from "../format";
import { useNow, usePoll } from "../hooks";
import { AsOf, ConfirmDialog, Empty, ErrorNote, Loading, Ok, PageHeader, Pill, type Tone } from "../components/ui";
import { currentSubscription, deviceLabel, endpointHash, keyMatches, permission, pushSupport, subscribe, unsubscribe } from "../notifications/browser";
import { useIncidentFeed } from "../notifications/feed";

const SEVERITY_TONE: Record<NotifySeverity, Tone> = { critical: "bad", warning: "warn", info: "info" };
const SOURCES: { id: NotifySource; label: string }[] = [
  { id: "endpoint", label: "Endpoints down or degraded" },
  { id: "alert", label: "Alertmanager alerts" },
  { id: "argo", label: "Argo CD apps degraded or failing to sync" },
  { id: "workflow", label: "Failed workflow runs on main (GitHub, Gitea)" },
];
const SOURCE_SHORT: Record<NotifySource, string> = { endpoint: "Endpoint", alert: "Alert", argo: "Argo CD", workflow: "Workflow" };
const SEVERITY_CHOICE: { id: NotifySeverity; label: string }[] = [
  { id: "critical", label: "Critical only" },
  { id: "warning", label: "Warnings and critical" },
  { id: "info", label: "Everything, info included" },
];
const FEEDS: Record<string, { label: string; every: number }> = {
  endpoint: { label: "Endpoints", every: 2 },
  alert: { label: "Alertmanager", every: 2 },
  argo: { label: "Argo CD", every: 2 },
  github: { label: "GitHub Actions", every: 10 },
  gitea: { label: "Gitea Actions", every: 10 },
};
const PAUSES = [
  { minutes: 60, label: "for 1 hour" },
  { minutes: 240, label: "for 4 hours" },
  { minutes: 480, label: "for 8 hours" },
  { minutes: 1440, label: "for 24 hours" },
];

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const lasted = (from: number, to: number) => ago(from, to).replace(" ago", "");

export function NotificationsPage() {
  const feed = useIncidentFeed();
  const devices = usePoll(() => api<Devices>("/api/notify/devices"), 60_000);
  const now = useNow();
  const [actionError, setActionError] = useState<unknown>(null);

  /** Run a change, then re-read the feed so the page shows the server's answer, not a guess. */
  const run = useCallback(
    async (change: () => Promise<unknown>) => {
      setActionError(null);
      try {
        await change();
      } catch (err) {
        setActionError(err);
      }
      await feed.reload();
    },
    [feed],
  );

  const data = feed.data;
  const paused = data?.mutes.find((m) => m.key === "*") ?? null;

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle={
          <>
            <AsOf at={feed.fetchedAt} loading={feed.loading} every={feed.intervalMs} /> · what hdctl found wrong, and what it pushed to your devices
          </>
        }
      >
        {data &&
          (paused ? (
            <button className="btn" onClick={() => void run(() => send("DELETE", `/api/notify/mutes/${paused.id}`))}>
              Resume notifications
            </button>
          ) : (
            <select className="input" aria-label="Pause all notifications" value="" onChange={(e) => e.target.value && void run(() => post("/api/notify/pause", { minutes: Number(e.target.value) }))}>
              <option value="">Pause all…</option>
              {PAUSES.map((p) => (
                <option key={p.minutes} value={p.minutes}>
                  {p.label}
                </option>
              ))}
            </select>
          ))}
        <button className="btn" onClick={() => void Promise.all([feed.reload(), devices.reload()])} disabled={feed.loading}>
          Refresh
        </button>
      </PageHeader>

      <ThisDevice devices={devices} />

      <ErrorNote error={actionError} />
      <ErrorNote error={feed.error} />
      {!data && !feed.error && <Loading what="incidents" />}
      {data && (
        <>
          {paused && (
            <div className="note note-setup" role="status">
              <strong>Paused</strong>
              <span>
                Nothing is pushed until {clock(paused.until)} ({paused.actor}). Incidents are still recorded here.
              </span>
            </div>
          )}
          <FeedHealth feeds={data.feeds} now={now} />
          <OpenIncidents feed={data} now={now} run={run} />
          <Watching pending={data.pending} now={now} />
          <Muted mutes={data.mutes.filter((m) => m.key !== "*")} run={run} />
          <Recent recent={data.recent} />
        </>
      )}

      <DeviceList devices={devices} />

      <p className="muted small how">
        Every two minutes hdctl checks its own probes of every endpoint (pushed after two failed checks in a row; a whole group down, or the whole lab,
        is one notification), Alertmanager&apos;s firing alerts, and Argo CD apps that are degraded or failed to sync. Every ten minutes it checks for
        workflows whose latest run on the default branch failed. A recovery replaces the alarm on your lock screen. <em>Acknowledge</em> stops it
        escalating and takes it off your other devices; <em>Mute</em> holds every push about that one thing.
      </p>
    </>
  );
}

// --- This browser ---------------------------------------------------------------------

type DevicesPoll = ReturnType<typeof usePoll<Devices>>;

function ThisDevice({ devices }: { devices: DevicesPoll }) {
  const support = useMemo(pushSupport, []);
  const [local, setLocal] = useState<{
    permission: NotificationPermission | "unsupported";
    endpoint: string | null;
    hash: string | null;
    /** The key this browser subscribed with, if it says. */
    key: ArrayBuffer | null;
    checked: boolean;
  }>({ permission: permission(), endpoint: null, hash: null, key: null, checked: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);

  const refreshLocal = useCallback(async () => {
    const sub = await currentSubscription();
    setLocal({
      permission: permission(),
      endpoint: sub?.endpoint ?? null,
      hash: sub ? await endpointHash(sub.endpoint) : null,
      key: sub?.options?.applicationServerKey ?? null,
      checked: true,
    });
  }, []);
  useEffect(() => {
    void refreshLocal();
  }, [refreshLocal]);

  const mine = devices.data?.devices.find((d) => d.endpointHash === local.hash) ?? null;
  // Subscribed with a key the Worker no longer has (it lost its keypair): the push service refuses every push to it.
  const staleKey = mine !== null && devices.data !== null && !keyMatches(local.key, devices.data.publicKey);

  async function act(what: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      setNote(await what());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      await Promise.all([refreshLocal(), devices.reload()]);
    }
  }

  const turnOn = () =>
    act(async () => {
      const key = devices.data?.publicKey ?? (await api<Devices>("/api/notify/devices")).publicKey;
      // Nothing awaited before subscribe(): iOS only asks for permission straight from the tap.
      const before = local.endpoint;
      const sub = await subscribe(key);
      // A new subscription in place of an old one (a new key) keeps the device's preferences.
      const replaces = before && before !== sub.endpoint ? before : undefined;
      const res = await post<{ confirmation: PushResult | null }>("/api/notify/devices", { subscription: sub.toJSON(), label: deviceLabel(), replaces });
      if (!res.confirmation) return "This device is registered again.";
      return res.confirmation.ok ? "Notifications are on. A confirmation is on its way to this device." : `Registered, but the push service refused the confirmation: ${res.confirmation.error}`;
    });
  const turnOff = () =>
    act(async () => {
      await unsubscribe();
      if (mine) await send("DELETE", `/api/notify/devices/${mine.id}`);
      return "Turned off. hdctl won't push to this device any more.";
    });
  const test = (d: Device) => act(async () => pushOutcome(await post<PushResult>(`/api/notify/devices/${d.id}/test`)));

  let body: ReactNode;
  if (support.kind === "ios-install") {
    body = (
      <div className="note note-setup">
        <strong>Add hdctl to your Home Screen</strong>
        <span>On iPhone and iPad, notifications only reach the Home Screen app. In Safari tap Share, then Add to Home Screen, open hdctl from there, and turn them on.</span>
      </div>
    );
  } else if (support.kind === "unsupported") {
    body = <p className="muted">This browser can&apos;t receive push notifications.</p>;
  } else if (devices.error) {
    body = <ErrorNote error={devices.error} />;
  } else if (!devices.data || !local.checked) {
    body = <Loading what="this device's notification settings" />;
  } else if (local.permission === "denied") {
    body = (
      <div className="note note-error">
        <strong>Blocked</strong>
        <span>Notifications are blocked for hdctl in this browser. Allow them in its site settings, then reload this page.</span>
      </div>
    );
  } else if (!local.hash) {
    body = (
      <div className="device-state">
        <span>Notifications are off on this device.</span>
        <button className="btn btn-primary" onClick={() => void turnOn()} disabled={busy}>
          {busy ? "Turning on…" : "Turn on notifications"}
        </button>
      </div>
    );
  } else if (staleKey) {
    body = (
      <div className="device-state">
        <span>This device subscribed with an earlier key, so the push service refuses hdctl&apos;s notifications to it. Turn them on again to resubscribe; its preferences stay.</span>
        <button className="btn btn-primary" onClick={() => void turnOn()} disabled={busy}>
          {busy ? "Turning on…" : "Turn on again"}
        </button>
      </div>
    );
  } else if (!mine) {
    body = (
      <div className="device-state">
        <span>This browser is subscribed, but hdctl doesn&apos;t have it (it was removed, or the browser replaced its subscription).</span>
        <button className="btn btn-primary" onClick={() => void turnOn()} disabled={busy}>
          Register this device
        </button>
      </div>
    );
  } else {
    body = (
      <div className="device-state">
        <span>
          <Pill tone="good">on</Pill> <strong>{mine.label}</strong> <span className="muted small">· preferences below</span>
        </span>
        <span className="device-actions">
          <button className="btn" onClick={() => void test(mine)} disabled={busy}>
            Send a test
          </button>
          <button className="btn" onClick={() => void turnOff()} disabled={busy}>
            Turn off
          </button>
        </span>
      </div>
    );
  }

  return (
    <section className="group">
      <h2 className="group-title">This device</h2>
      {body}
      {note && <div className="note note-ok small" role="status"><span>{note}</span></div>}
      <ErrorNote error={error} />
    </section>
  );
}

const pushOutcome = (r: PushResult) =>
  r.ok ? "Sent. It should arrive within a few seconds." : r.gone ? `The push service says that subscription is gone, so hdctl forgot it: ${r.error}` : `The push service refused it: ${r.error}`;

// --- Every device ------------------------------------------------------------------------

function DeviceList({ devices }: { devices: DevicesPoll }) {
  const now = useNow();
  const [myHash, setMyHash] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Device | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void currentSubscription().then(async (s) => setMyHash(s ? await endpointHash(s.endpoint) : null));
  }, [devices.data]);

  if (!devices.data?.devices.length) return null;
  const list = [...devices.data.devices].sort((a, b) => Number(b.endpointHash === myHash) - Number(a.endpointHash === myHash));

  async function change(d: Device, patch: Partial<Pick<Device, "sources" | "minSeverity" | "recoveries">>) {
    setError(null);
    try {
      await send("PATCH", `/api/notify/devices/${d.id}`, patch);
    } catch (err) {
      setError(err);
    }
    await devices.reload();
  }
  async function test(d: Device) {
    setError(null);
    setNote(null);
    try {
      setNote(`${d.label}: ${pushOutcome(await post<PushResult>(`/api/notify/devices/${d.id}/test`))}`);
    } catch (err) {
      setError(err);
    }
    await devices.reload();
  }

  return (
    <section className="group">
      <h2 className="group-title">Devices</h2>
      <ErrorNote error={error} />
      {note && <div className="note note-ok small" role="status"><span>{note}</span></div>}
      <ul className="list devices">
        {list.map((d) => (
          <li key={d.id} className="list-item device">
            <div className="list-main">
              <div>
                <strong>{d.label}</strong> {d.endpointHash === myHash && <Pill tone="info">this device</Pill>}
              </div>
              <div className="muted small">
                {d.service} push · added {time(d.createdAt)} by {d.actor} · {d.lastSentAt ? `last delivered ${ago(d.lastSentAt, now)}` : "nothing delivered yet"}
              </div>
              {d.lastError && (
                <div className="small tone-warn">
                  {d.lastError} ({ago(d.lastErrorAt, now)})
                </div>
              )}
              <Prefs device={d} onChange={(p) => void change(d, p)} />
            </div>
            <div className="row-actions">
              <button className="btn btn-sm" onClick={() => void test(d)}>
                Test
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => setRemoving(d)}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.label ?? "device"}?`}
        confirmLabel="Remove"
        danger
        onConfirm={async () => {
          await send("DELETE", `/api/notify/devices/${removing!.id}`);
          await devices.reload();
        }}
        onClose={() => setRemoving(null)}
      >
        <p>It stops getting notifications from hdctl. To get them again, turn them on from that device.</p>
      </ConfirmDialog>
    </section>
  );
}

function Prefs({ device, onChange }: { device: Device; onChange: (p: Partial<Pick<Device, "sources" | "minSeverity" | "recoveries">>) => void }) {
  return (
    <div className="prefs">
      <fieldset className="prefs-sources">
        <legend className="muted small">Notify about</legend>
        {SOURCES.map((s) => {
          const on = device.sources.includes(s.id);
          return (
            <label key={s.id} className="toggle">
              <input
                type="checkbox"
                checked={on}
                // At least one: a device that wants nothing should turn notifications off.
                disabled={on && device.sources.length === 1}
                onChange={() => onChange({ sources: on ? device.sources.filter((x) => x !== s.id) : [...device.sources, s.id] })}
              />
              {s.label}
            </label>
          );
        })}
      </fieldset>
      <div className="prefs-row">
        <select className="input" aria-label={`Severity for ${device.label}`} value={device.minSeverity} onChange={(e) => onChange({ minSeverity: e.target.value as NotifySeverity })}>
          {SEVERITY_CHOICE.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <label className="toggle">
          <input type="checkbox" checked={device.recoveries} onChange={() => onChange({ recoveries: !device.recoveries })} />
          Tell me when it&apos;s resolved
        </label>
      </div>
    </div>
  );
}

// --- The record ---------------------------------------------------------------------------

/** Each feed's last evaluation: an error, or one not run for a while, means the record below may be behind. */
function FeedHealth({ feeds, now }: { feeds: FeedStatus[]; now: number }) {
  const shown = feeds.filter((f) => FEEDS[f.feed]);
  if (!shown.length) return null;
  const late = (f: FeedStatus) => now - f.checkedAt > (FEEDS[f.feed]!.every * 2 + 1) * 60_000;
  return (
    <section className="group">
      <div className="feeds small" aria-label="What hdctl evaluates">
        {shown.map((f) => (
          <span key={f.feed} className="feed" title={f.error ?? `evaluated ${time(f.checkedAt)}`}>
            <span className={`dot ${f.error ? "dot-bad" : late(f) ? "dot-warn" : "dot-good"}`} aria-hidden /> {FEEDS[f.feed]!.label}{" "}
            <span className="muted">{ago(f.checkedAt, now)}</span>
          </span>
        ))}
      </div>
      {shown
        .filter((f) => f.error || late(f))
        .map((f) => (
          <div key={f.feed} className="note note-error small feed-error" role="alert">
            <strong>{FEEDS[f.feed]!.label}</strong>
            <span>
              {f.error
                ? `couldn't be read: ${f.error}. ${f.okAt ? `Its incidents are as of its last good read, ${time(f.okAt)}.` : "It has never been read."}`
                : `not evaluated for ${lasted(f.checkedAt, now)}: notifications may be late.`}
            </span>
          </div>
        ))}
    </section>
  );
}

function OpenIncidents({ feed, now, run }: { feed: IncidentFeed; now: number; run: (c: () => Promise<unknown>) => Promise<void> }) {
  return (
    <section className="group">
      <h2 className="group-title">Open</h2>
      {feed.open.length === 0 ? (
        <Ok>Nothing open.</Ok>
      ) : (
        <ul className="list incidents">
          {feed.open.map((i) => {
            const mute = feed.mutes.find((m) => m.key === i.key);
            return (
              <li key={i.id} className={`list-item incident${i.ackedAt ? " incident-acked" : ""}`}>
                <Pill tone={SEVERITY_TONE[i.severity]}>{i.severity}</Pill>
                <div className="list-main">
                  <Title incident={i} />
                  <div className="small">{i.body}</div>
                  <div className="muted small">
                    {SOURCE_SHORT[i.source]} · since {clock(i.firstSeenAt)} ({lasted(i.firstSeenAt, now)}) · still failing at {clock(i.lastSeenAt)}
                    {i.ackedAt && ` · acknowledged by ${i.ackedBy}`}
                    {i.mutedUntil && ` · muted until ${clock(i.mutedUntil)}`}
                    {!i.pushed && " · not pushed (muted when it opened)"}
                  </div>
                </div>
                <div className="row-actions">
                  {!i.ackedAt && (
                    <button className="btn btn-sm" onClick={() => void run(() => post(`/api/notify/incidents/${i.id}/ack`))}>
                      Acknowledge
                    </button>
                  )}
                  {mute ? (
                    <button className="btn btn-sm" onClick={() => void run(() => send("DELETE", `/api/notify/mutes/${mute.id}`))}>
                      Unmute
                    </button>
                  ) : (
                    <button className="btn btn-sm" onClick={() => void run(() => post(`/api/notify/incidents/${i.id}/mute`, { minutes: 60 }))}>
                      Mute 1 h
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Title({ incident: i }: { incident: Incident }) {
  return (
    <div>
      <Link to={i.url} className="strong">
        {i.title}
      </Link>
      {i.link && (
        <>
          {" "}
          <a href={i.link} target="_blank" rel="noreferrer" className="muted small" aria-label={`Open ${i.subject}`}>
            ↗
          </a>
        </>
      )}
    </div>
  );
}

/** Seen failing, not yet for long enough to tell anyone: the debounce, made visible. */
function Watching({ pending, now }: { pending: Incident[]; now: number }) {
  if (!pending.length) return null;
  return (
    <section className="group">
      <h2 className="group-title">Watching</h2>
      <ul className="list">
        {pending.map((i) => (
          <li key={i.id} className="list-item">
            <Pill tone="muted">pending</Pill>
            <div className="list-main">
              <Title incident={i} />
              <div className="muted small">
                {i.body} · failing since {clock(i.firstSeenAt)} ({lasted(i.firstSeenAt, now)}). Pushed if it&apos;s still failing at the next check.
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Muted({ mutes, run }: { mutes: Mute[]; run: (c: () => Promise<unknown>) => Promise<void> }) {
  if (!mutes.length) return null;
  return (
    <section className="group">
      <h2 className="group-title">Muted</h2>
      <ul className="list">
        {mutes.map((m) => (
          <li key={m.id} className="list-item">
            <div className="list-main">
              <strong>{m.label}</strong>
              <div className="muted small">
                until {clock(m.until)} · by {m.actor}
              </div>
            </div>
            <div className="row-actions">
              <button className="btn btn-sm" onClick={() => void run(() => send("DELETE", `/api/notify/mutes/${m.id}`))}>
                Unmute
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Recent({ recent }: { recent: Incident[] }) {
  return (
    <section className="group">
      <h2 className="group-title">Resolved in the last 7 days</h2>
      {recent.length === 0 ? (
        <Empty>Nothing yet.</Empty>
      ) : (
        <ul className="list">
          {recent.map((i) => (
            <li key={i.id} className="list-item">
              <Pill tone="good">resolved</Pill>
              <div className="list-main">
                <Title incident={i} />
                <div className="muted small">
                  {i.resolution} · lasted {lasted(i.firstSeenAt, i.resolvedAt!)} · {time(i.resolvedAt!)}
                  {i.ackedBy && ` · acknowledged by ${i.ackedBy}`}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
