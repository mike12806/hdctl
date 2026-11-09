import { describe, expect, it } from "vitest";
import { parseExposition, parseMonitors } from "../src/integrations/kuma";
import { targetById } from "../src/targets";
import { call, healthy, testEnv, type Upstream } from "./helpers/worker";

/** Uptime Kuma: read from Kuma's own /metrics with an API key, live, and nothing else. */

const KEY = "uk1_test-key";

const METRICS = `# HELP monitor_cert_days_remaining The number of days remaining until the certificate expires
# TYPE monitor_cert_days_remaining gauge
monitor_cert_days_remaining{monitor_name="Argo",monitor_type="http",monitor_url="https://argo.mfaherty.net",monitor_hostname="null",monitor_port="null"} 9
monitor_cert_days_remaining{monitor_name="Vault",monitor_type="http",monitor_url="https://vault.mfaherty.net",monitor_hostname="null",monitor_port="null"} 61
# HELP monitor_cert_is_valid Is the certificate still valid? (1 = Yes, 0= No)
# TYPE monitor_cert_is_valid gauge
monitor_cert_is_valid{monitor_name="Argo",monitor_type="http",monitor_url="https://argo.mfaherty.net",monitor_hostname="null",monitor_port="null"} 1
monitor_cert_is_valid{monitor_name="Vault",monitor_type="http",monitor_url="https://vault.mfaherty.net",monitor_hostname="null",monitor_port="null"} 1
# HELP monitor_response_time Monitor Response Time (ms)
# TYPE monitor_response_time gauge
monitor_response_time{monitor_name="Argo",monitor_type="http",monitor_url="https://argo.mfaherty.net",monitor_hostname="null",monitor_port="null"} 112
monitor_response_time{monitor_name="Vault",monitor_type="http",monitor_url="https://vault.mfaherty.net",monitor_hostname="null",monitor_port="null"} 48
monitor_response_time{monitor_name="dns9 \\"primary\\"",monitor_type="dns",monitor_url="null",monitor_hostname="192.168.9.9",monitor_port="53"} -1
monitor_response_time{monitor_name="dns-failover push",monitor_type="push",monitor_url="null",monitor_hostname="null",monitor_port="null"} 0
# HELP monitor_status Monitor Status (1 = UP, 0= DOWN, 2= PENDING, 3= MAINTENANCE)
# TYPE monitor_status gauge
monitor_status{monitor_name="Argo",monitor_type="http",monitor_url="https://argo.mfaherty.net",monitor_hostname="null",monitor_port="null"} 1
monitor_status{monitor_name="Vault",monitor_type="http",monitor_url="https://vault.mfaherty.net",monitor_hostname="null",monitor_port="null"} 3
monitor_status{monitor_name="dns9 \\"primary\\"",monitor_type="dns",monitor_url="null",monitor_hostname="192.168.9.9",monitor_port="53"} 0
monitor_status{monitor_name="dns-failover push",monitor_type="push",monitor_url="null",monitor_hostname="null",monitor_port="null"} 2
# HELP process_cpu_user_seconds_total Total user CPU time spent in seconds.
# TYPE process_cpu_user_seconds_total counter
process_cpu_user_seconds_total 12.5
`;

/** A fake Kuma: /metrics for the right key (Basic auth, empty username) only. */
const kumaUp: Upstream = (t, req) => {
  if (t.id !== "kuma" || new URL(req.url).pathname !== "/metrics") return healthy(t, req);
  if (req.headers.get("Authorization") !== `Basic ${btoa(`:${KEY}`)}`) return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Basic" } });
  return new Response(METRICS, { headers: { "Content-Type": "text/plain; version=0.0.4" } });
};

describe("the Kuma target", () => {
  it("is pinned by IP to Kuma on the LAN, and checked on an endpoint that needs no key", () => {
    expect(targetById("kuma")).toMatchObject({ address: { ipv4: "192.168.9.7" }, port: 3001, binding: "KUMA", check: { path: "/api/entry-page" } });
  });
});

describe("parseExposition", () => {
  it("reads names, escaped label values and values, and skips comments", () => {
    const s = parseExposition('a 1\n# HELP x\nb{k="v\\\\x\\"y",j="{}"} 2.5 1700000000\n');
    expect(s).toEqual([
      { name: "a", labels: {}, value: 1 },
      { name: "b", labels: { k: 'v\\x"y', j: "{}" }, value: 2.5 },
    ]);
  });
});

describe("parseMonitors", () => {
  const monitors = parseMonitors(METRICS);

  it("joins each monitor's metrics into one row, problems first", () => {
    expect(monitors.map((m) => [m.name, m.status])).toEqual([
      ['dns9 "primary"', "down"],
      ["dns-failover push", "pending"],
      ["Vault", "maintenance"],
      ["Argo", "up"],
    ]);
    expect(monitors.find((m) => m.name === "Argo")).toEqual({
      name: "Argo",
      type: "http",
      target: "https://argo.mfaherty.net",
      status: "up",
      responseTimeMs: 112,
      certDaysRemaining: 9,
      certValid: true,
    });
  });

  it("shows host:port for non-HTTP monitors, and no response time before the first answer", () => {
    const dns = monitors.find((m) => m.type === "dns")!;
    expect(dns.target).toBe("192.168.9.9:53");
    expect(dns.responseTimeMs).toBeNull();
    expect(dns.certDaysRemaining).toBeNull();
    expect(monitors.find((m) => m.type === "push")!.target).toBeNull();
  });

  it("doesn't split a monitor in two because of extra (tag) labels", () => {
    const tagged = 'monitor_status{monitor_name="A",monitor_type="http",monitor_url="u",monitor_hostname="null",monitor_port="null",env="prod"} 1\nmonitor_response_time{monitor_name="A",monitor_type="http",monitor_url="u",monitor_hostname="null",monitor_port="null",env="prod"} 5\n';
    expect(parseMonitors(tagged)).toHaveLength(1);
  });
});

describe("GET /api/kuma", () => {
  it("reads /metrics from Kuma itself with the API key, on every request", async () => {
    const t = testEnv({ vars: { KUMA_API_KEY: KEY }, upstream: kumaUp });
    const res = await call(t.env, "/api/kuma");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, number>; monitors: unknown[] };
    expect(body.counts).toEqual({ up: 1, down: 1, pending: 1, maintenance: 1, unknown: 0 });
    expect(body.monitors).toHaveLength(4);
    await call(t.env, "/api/kuma");
    const kumaCalls = t.calls.filter((c) => c.target === "kuma");
    expect(kumaCalls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /metrics", "GET /metrics"]);
    expect(t.cache.size).toBe(0);
  });

  it("says how to set it up while the key is missing, without calling Kuma", async () => {
    const t = testEnv({ upstream: kumaUp });
    const res = await call(t.env, "/api/kuma");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ setup: true, error: expect.stringContaining("KUMA_API_KEY") });
    expect(t.calls.filter((c) => c.target === "kuma")).toHaveLength(0);
  });

  it("reports a rejected key as Kuma's error, with no data", async () => {
    const t = testEnv({ vars: { KUMA_API_KEY: "uk1_wrong" }, upstream: kumaUp });
    const res = await call(t.env, "/api/kuma");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; monitors?: unknown };
    expect(body.error).toMatch(/refused the API key/);
    expect(body.monitors).toBeUndefined();
  });
});
