import { describe, expect, it } from "vitest";
import {
  DNS_QUERY,
  MACHINES_QUERY,
  NETWORK_QUERY,
  SCRAPE_QUERY,
  VOLUMES_QUERY,
  WORKLOADS_QUERY,
  parseAlerts,
  parseDns,
  parseMachines,
  parseNetwork,
  parseVolumes,
  parseWorkloads,
  type Sample,
} from "../src/integrations/prometheus";
import { call, healthy, testEnv, type Upstream } from "./helpers/worker";

const s = (metric: Record<string, string>, value: number): Sample => ({ metric, value });

describe("parseMachines", () => {
  const host = { job: "proxmox-node-exporter", instance: "192.168.1.12:9100" };
  const node = { job: "node-exporter", instance: "10.0.0.5:9796" };
  const samples = [
    s({ m: "up", ...host }, 1),
    s({ m: "info", ...host, nodename: "pve" }, 1),
    s({ m: "cpu", instance: host.instance }, 0.25),
    s({ m: "mem", ...host }, 0.5),
    s({ m: "uptime", ...host }, 3600),
    s({ m: "up", ...node }, 1),
    s({ m: "info", ...node, nodename: "k8node2" }, 1),
    s({ m: "ready", node: "k8node2", instance: "ksm:8080" }, 0),
    s({ m: "up", job: "node-exporter", instance: "10.0.0.6:9796" }, 0),
  ];

  it("names Proxmox hosts after their hdctl target, since pve4 calls itself pve", () => {
    const [pve4] = parseMachines(samples);
    expect(pve4).toMatchObject({ name: "pve4", kind: "host", up: true, ready: null, cpu: 0.25, mem: 0.5, uptime: 3600, disk: null });
  });

  it("reports a k3s node's Ready condition, and a machine whose exporter is down", () => {
    const machines = parseMachines(samples);
    expect(machines.find((m) => m.name === "k8node2")).toMatchObject({ kind: "k8s", up: true, ready: false });
    expect(machines.find((m) => m.instance === "10.0.0.6:9796")).toMatchObject({ up: false, cpu: null });
  });

  it("lists hosts first, then nodes in natural order", () => {
    const names = parseMachines([
      s({ m: "up", job: "node-exporter", instance: "a" }, 1),
      s({ m: "info", job: "node-exporter", instance: "a", nodename: "k8node10" }, 1),
      s({ m: "up", job: "node-exporter", instance: "b" }, 1),
      s({ m: "info", job: "node-exporter", instance: "b", nodename: "k8node9" }, 1),
      s({ m: "up", ...host }, 1),
    ]).map((m) => m.name);
    expect(names).toEqual(["pve4", "k8node9", "k8node10"]);
  });
});

describe("parseWorkloads", () => {
  it("lists what needs attention, without repeating a crash-looping pod as not ready", () => {
    const w = parseWorkloads([
      s({ m: "waiting", namespace: "a", pod: "web-1", container: "app", reason: "CrashLoopBackOff" }, 1),
      s({ m: "notReady", namespace: "a", pod: "web-1" }, 1),
      s({ m: "deployment", namespace: "b", deployment: "api" }, 2),
      s({ m: "failedJob", namespace: "c", job_name: "nightly-123" }, 1),
      s({ m: "restarts", namespace: "a", pod: "web-1", container: "app" }, 1.97),
      s({ m: "restarts", namespace: "d", pod: "db-0", container: "pg" }, 6.1),
      s({ m: "running" }, 300),
      s({ m: "pods" }, 330),
    ]);
    expect(w.podsRunning).toBe(300);
    expect(w.problems).toEqual([
      { kind: "waiting", namespace: "a", name: "web-1", detail: "CrashLoopBackOff (app)" },
      { kind: "deployment", namespace: "b", name: "api", detail: "2 unavailable" },
      { kind: "failedJob", namespace: "c", name: "nightly-123", detail: "failed in the last 24 h" },
    ]);
    expect(w.restarts.map((r) => [r.pod, r.count])).toEqual([["db-0", 6], ["web-1", 2]]);
  });
});

describe("parseVolumes", () => {
  it("returns the fullest volumes with their size, one entry per claim", () => {
    const v = parseVolumes([
      s({ m: "ratio", namespace: "harbor", persistentvolumeclaim: "trivy", node: "n1" }, 0.82),
      s({ m: "ratio", namespace: "harbor", persistentvolumeclaim: "trivy", node: "n2" }, 0.8),
      s({ m: "ratio", namespace: "redpanda", persistentvolumeclaim: "data-0" }, 0.17),
      s({ m: "capacity", namespace: "harbor", persistentvolumeclaim: "trivy" }, 5e9),
    ]);
    expect(v.count).toBe(2);
    expect(v.fullest[0]).toEqual({ namespace: "harbor", claim: "trivy", used: 0.82, capacity: 5e9 });
  });
});

describe("parseNetwork", () => {
  it("reads WAN rates, latency and client counts from unpoller", () => {
    const wan = { name: "udm", port: "eth8" };
    const n = parseNetwork([
      s({ __name__: "unpoller_device_wan_receive_rate_bytes", ...wan }, 1_250_000),
      s({ __name__: "unpoller_device_wan_transmit_rate_bytes", ...wan }, 250_000),
      s({ __name__: "unpoller_device_wan_latency_seconds", ...wan }, 0.011),
      s({ __name__: "unpoller_device_wan_availability_percent", ...wan }, 100),
      s({ __name__: "unpoller_site_users", subsystem: "wlan" }, 43),
      s({ __name__: "unpoller_site_users", subsystem: "lan" }, 50),
      s({ __name__: "unpoller_site_aps", subsystem: "wlan" }, 5),
      s({ __name__: "unpoller_site_disconnected", subsystem: "lan" }, 0),
      s({ __name__: "unpoller_site_disconnected", subsystem: "wlan" }, 1),
      s({ __name__: "unpoller_site_latency_seconds", subsystem: "www" }, 0.017),
      s({ __name__: "unpoller_site_xput_down_rate", subsystem: "www" }, 926),
    ]);
    expect(n.wans).toEqual([{ device: "udm", port: "eth8", downloadBps: 1_250_000, uploadBps: 250_000, latencyMs: 11, availability: 100 }]);
    expect(n).toMatchObject({ wifiClients: 43, wiredClients: 50, accessPoints: 5, disconnectedDevices: 1, internetLatencyMs: 17, guests: null });
    expect(n.speedtest).toEqual({ downMbps: 926, upMbps: null, pingMs: null });
  });
});

describe("parseDns", () => {
  it("groups the exporter's series by Pi-hole", () => {
    expect(
      parseDns([
        s({ __name__: "pihole_dns_queries_today", hostname: "dns9" }, 187010),
        s({ __name__: "pihole_ads_percentage_today", hostname: "dns9" }, 5.07),
        s({ __name__: "pihole_status", hostname: "dns9" }, 1),
        s({ __name__: "pihole_status", hostname: "dns10" }, 0),
      ]),
    ).toEqual([
      { host: "dns9", enabled: true, queriesToday: 187010, blockedToday: null, blockedPercent: 5.07, clients: null },
      { host: "dns10", enabled: false, queriesToday: null, blockedToday: null, blockedPercent: null, clients: null },
    ]);
  });
});

describe("parseAlerts", () => {
  const alert = (labels: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    labels,
    annotations: { summary: "Job failed to complete.", description: "Job kube-system/x failed to complete. Removing failed job after investigation should clear this alert on cluster ." },
    startsAt: "2026-11-08T07:29:29Z",
    status: { state: "active", silencedBy: [], inhibitedBy: [] },
    ...extra,
  });

  it("drops the always-firing plumbing alerts", () => {
    expect(parseAlerts([alert({ alertname: "Watchdog", severity: "none" }), alert({ alertname: "InfoInhibitor", severity: "none" })])).toEqual([]);
  });

  it("points at the workload, not the exporter pod that reported it, and tidies Rancher's text", () => {
    const [a] = parseAlerts([alert({ alertname: "KubeJobFailed", severity: "warning", namespace: "kube-system", job_name: "x", pod: "kube-state-metrics-abc" })]);
    expect(a).toMatchObject({ name: "KubeJobFailed", severity: "warning", state: "firing", where: "kube-system/x" });
    expect(a!.description).toBe("Job kube-system/x failed to complete. Removing failed job after investigation should clear this alert.");
  });

  it("puts firing critical alerts first and silenced ones last", () => {
    const names = parseAlerts([
      alert({ alertname: "Silenced", severity: "critical" }, { status: { state: "suppressed", silencedBy: ["s1"], inhibitedBy: [] } }),
      alert({ alertname: "Warn", severity: "warning" }),
      alert({ alertname: "Crit", severity: "critical" }),
    ]).map((a) => `${a.name}:${a.state}`);
    expect(names).toEqual(["Crit:firing", "Warn:firing", "Silenced:silenced"]);
  });
});

describe("GET /api/metrics", () => {
  /** A fake Prometheus that answers each section's query, and an Alertmanager. */
  const vector = (result: { metric: Record<string, string>; value: [number, string] }[]) =>
    Response.json({ status: "success", data: { resultType: "vector", result } });
  const fakeMonitoring: Upstream = (t, req) => {
    const url = new URL(req.url);
    if (t.id === "alertmanager" && url.pathname === "/api/v2/alerts") {
      return Response.json([{ labels: { alertname: "KubeJobFailed", severity: "warning", namespace: "ns", job_name: "j" }, annotations: {}, startsAt: "2026-11-08T07:00:00Z", status: { silencedBy: [], inhibitedBy: [] } }]);
    }
    if (t.id === "prometheus" && url.pathname === "/api/v1/query") {
      const q = url.searchParams.get("query") ?? "";
      if (q === MACHINES_QUERY) return vector([{ metric: { m: "up", job: "node-exporter", instance: "n1:9796" }, value: [0, "1"] }]);
      if (q === WORKLOADS_QUERY) return vector([{ metric: { m: "running" }, value: [0, "306"] }]);
      if (q === VOLUMES_QUERY) return vector([]);
      if (q === NETWORK_QUERY) return vector([{ metric: { __name__: "unpoller_site_users", subsystem: "wlan" }, value: [0, "43"] }]);
      if (q === DNS_QUERY) return vector([{ metric: { __name__: "pihole_status", hostname: "dns9" }, value: [0, "1"] }]);
      if (q === SCRAPE_QUERY) return vector([{ metric: { m: "total" }, value: [0, "113"] }]);
      return Response.json({ status: "error", error: "unknown query" }, { status: 400 });
    }
    return healthy(t, req);
  };

  it("asks Prometheus and Alertmanager on every request, one query per section", async () => {
    const t = testEnv({ upstream: fakeMonitoring });
    const body = (await (await call(t.env, "/api/metrics")).json()) as Record<string, { data: unknown; error: string | null }>;
    expect(body.alerts).toMatchObject({ error: null, data: [{ name: "KubeJobFailed", where: "ns/j" }] });
    expect(body.machines).toMatchObject({ error: null, data: [{ instance: "n1:9796", up: true }] });
    expect(body.workloads).toMatchObject({ error: null, data: { podsRunning: 306 } });
    expect(body.network).toMatchObject({ error: null, data: { wifiClients: 43 } });
    expect(body.dns).toMatchObject({ error: null, data: [{ host: "dns9", enabled: true }] });
    expect(body.scrape).toMatchObject({ error: null, data: { total: 113, down: [] } });
    expect(t.calls.filter((c) => c.target === "prometheus")).toHaveLength(6);
    expect(t.calls.filter((c) => c.target === "alertmanager")).toHaveLength(1);

    await call(t.env, "/api/metrics");
    expect(t.calls).toHaveLength(14); // nothing cached
  });

  it("shows Prometheus being down as an error in its sections, never older data, and keeps the alerts", async () => {
    const t = testEnv({
      upstream: (target, req) => {
        if (target.id === "prometheus") throw new TypeError("connection refused");
        return fakeMonitoring(target, req);
      },
    });
    const res = await call(t.env, "/api/metrics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, { data: unknown; error: string | null }>;
    for (const name of ["machines", "workloads", "volumes", "network", "dns", "scrape"]) {
      expect(body[name], name).toEqual({ data: null, error: "connection refused" });
    }
    expect(body.alerts!.error).toBeNull();
  });

  it("reports a PromQL error as that section's error", async () => {
    const t = testEnv({
      upstream: (target, req) =>
        target.id === "prometheus" && new URL(req.url).searchParams.get("query") === DNS_QUERY
          ? Response.json({ status: "error", error: "parse error" }, { status: 400 })
          : fakeMonitoring(target, req),
    });
    const body = (await (await call(t.env, "/api/metrics")).json()) as Record<string, { data: unknown; error: string | null }>;
    expect(body.dns).toEqual({ data: null, error: "Prometheus: parse error" });
    expect(body.network!.error).toBeNull();
  });
});
