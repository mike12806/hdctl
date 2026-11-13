import { describe, expect, it } from "vitest";
import { PIHOLES } from "../src/integrations/pihole";
import type { Target } from "../src/targets";
import { call, healthy, testEnv, type Upstream } from "./helpers/worker";

const PASSWORDS = Object.fromEntries(PIHOLES.map((t) => [t.id, `app-pw-${t.id}`]));
const vars = { PIHOLE_PASSWORDS: JSON.stringify(PASSWORDS) };

interface Overrides {
  /** Per host: a whole response to the login, instead of a session. */
  login?: Record<string, () => Response>;
  summary?: Record<string, () => Response>;
  blocking?: Record<string, string>;
  logout?: Record<string, () => Response>;
}

/**
 * A fake FTL v6 API per Pi-hole target: /api/auth hands out a session id per
 * host when given that host's password, and the read endpoints refuse any
 * request without it, as FTL does.
 */
function fakePiholes(o: Overrides = {}): Upstream {
  return async (t: Target, req: Request) => {
    if (t.group !== "dns") return healthy(t, req);
    const path = new URL(req.url).pathname;
    const sid = `sid-${t.id}`;
    if (path === "/api/auth" && req.method === "POST") {
      if (o.login?.[t.id]) return o.login[t.id]!();
      const { password } = (await req.json()) as { password: string };
      if (password !== PASSWORDS[t.id]) return Response.json({ session: { valid: false, totp: false, sid: null, message: "password incorrect" } }, { status: 401 });
      return Response.json({ session: { valid: true, totp: false, sid, csrf: "c", validity: 1800, message: "app-password correct" } });
    }
    if (req.headers.get("X-FTL-SID") !== sid) return Response.json({ error: { key: "unauthorized", message: "Unauthorized", hint: null } }, { status: 401 });
    if (path === "/api/auth" && req.method === "DELETE") return o.logout?.[t.id]?.() ?? new Response(null, { status: 204 });
    if (path === "/api/stats/summary") {
      if (o.summary?.[t.id]) return o.summary[t.id]!();
      return Response.json({
        queries: { total: 187010, blocked: 9481, percent_blocked: 5.07, unique_domains: 4000, forwarded: 1, cached: 2 },
        clients: { active: 42, total: 60 },
        gravity: { domains_being_blocked: 1_000_000 },
        took: 0.001,
      });
    }
    if (path === "/api/dns/blocking") return Response.json({ blocking: o.blocking?.[t.id] ?? "enabled", timer: null, took: 0 });
    return new Response("not stubbed", { status: 404 });
  };
}

type Body = { hosts: { host: string; error: string | null; enabled: boolean | null; queriesToday: number | null; blockedToday: number | null; blockedPercent: number | null; clients: number | null }[] };

describe("GET /api/dns", () => {
  it("logs in to each Pi-hole with its app password, reads it, and logs out, on every request", async () => {
    const t = testEnv({ upstream: fakePiholes({ blocking: { dns8: "disabled" } }), vars });
    const res = await call(t.env, "/api/dns");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.hosts.map((h) => h.host)).toEqual(["dns7", "dns8", "dns9", "dns10", "k8s-dns", "k8s-dns2"]);
    expect(body.hosts[0]).toMatchObject({ host: "dns7", error: null, enabled: true, queriesToday: 187010, blockedToday: 9481, blockedPercent: 5.07, clients: 42 });
    expect(body.hosts[1]).toMatchObject({ host: "dns8", enabled: false });

    for (const p of PIHOLES) {
      const mine = t.calls.filter((c) => c.target === p.id);
      // One session: log in, the two reads (in parallel), log out last.
      expect(mine.map((c) => `${c.method} ${c.path}`).sort()).toEqual(["DELETE /api/auth", "GET /api/dns/blocking", "GET /api/stats/summary", "POST /api/auth"]);
      expect(mine[0]).toMatchObject({ method: "POST", path: "/api/auth" });
      expect(JSON.parse(mine[0]!.body)).toEqual({ password: `app-pw-${p.id}` });
      expect(mine.at(-1)).toMatchObject({ method: "DELETE", path: "/api/auth" });
      for (const c of mine.slice(1)) expect(c.headers.get("X-FTL-SID")).toBe(`sid-${p.id}`);
    }
    // Nothing from pihole-exporter or Prometheus.
    expect(t.calls.filter((c) => !PIHOLES.some((p) => p.id === c.target))).toEqual([]);

    await call(t.env, "/api/dns");
    expect(t.calls).toHaveLength(PIHOLES.length * 4 * 2); // nothing cached
  });

  it("shows a Pi-hole that fails as its error with no numbers, and the others as normal", async () => {
    const base = fakePiholes({
      login: { "k8s-dns": () => Response.json({ error: { key: "api_seats_exceeded", message: "API seats exceeded", hint: "increase webserver.api.max_sessions" } }, { status: 429 }) },
      summary: { dns9: () => Response.json({ error: { key: "database_error", message: "Internal server error", hint: null } }, { status: 500 }) },
    });
    const t = testEnv({
      vars,
      upstream: (target, req) => {
        if (target.id === "dns10") throw new TypeError("connection refused");
        return base(target, req);
      },
    });

    const body = (await (await call(t.env, "/api/dns")).json()) as Body;
    const by = Object.fromEntries(body.hosts.map((h) => [h.host, h]));
    const none = { enabled: null, queriesToday: null, blockedToday: null, blockedPercent: null, clients: null };
    expect(by["k8s-dns"]).toMatchObject({ error: "login refused: HTTP 429 API seats exceeded (increase webserver.api.max_sessions)", ...none });
    expect(by.dns9).toMatchObject({ error: "GET /api/stats/summary: HTTP 500 Internal server error", ...none });
    expect(by.dns10).toMatchObject({ error: "connection refused", ...none });
    expect(by.dns7).toMatchObject({ error: null, queriesToday: 187010 });

    // A read that failed after login still closes the session.
    expect(t.calls.filter((c) => c.target === "dns9").map((c) => c.method).at(-1)).toBe("DELETE");
    // A refused login has no session to close.
    expect(t.calls.filter((c) => c.target === "k8s-dns" && c.method === "DELETE")).toEqual([]);
  });

  it("reports a wrong password with FTL's message, and never the password", async () => {
    const t = testEnv({ upstream: fakePiholes(), vars: { PIHOLE_PASSWORDS: JSON.stringify({ ...PASSWORDS, dns8: "wrong" }) } });
    const text = await (await call(t.env, "/api/dns")).text();
    const dns8 = (JSON.parse(text) as Body).hosts.find((h) => h.host === "dns8")!;
    expect(dns8).toMatchObject({ error: "login refused: password incorrect", queriesToday: null });
    expect(text).not.toContain("app-pw-");
    expect(text).not.toContain("wrong");
  });

  it("shows a host with no app password as its error, without calling it", async () => {
    const { dns7: _, ...rest } = PASSWORDS;
    const t = testEnv({ upstream: fakePiholes(), vars: { PIHOLE_PASSWORDS: JSON.stringify(rest) } });
    const body = (await (await call(t.env, "/api/dns")).json()) as Body;
    expect(body.hosts[0]).toMatchObject({ host: "dns7", error: "No app password for dns7 in PIHOLE_PASSWORDS.", queriesToday: null });
    expect(t.calls.filter((c) => c.target === "dns7")).toEqual([]);
  });

  it("keeps the numbers it read when logging out fails, and logs it", async () => {
    const t = testEnv({ upstream: fakePiholes({ logout: { dns7: () => Response.json({ error: { key: "x", message: "boom", hint: null } }, { status: 500 }) } }), vars });
    const body = (await (await call(t.env, "/api/dns")).json()) as Body;
    expect(body.hosts[0]).toMatchObject({ host: "dns7", error: null, queriesToday: 187010 });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("pihole logout failed"));
  });

  it("answers 503 with a setup hint, calling nothing, while PIHOLE_PASSWORDS is missing", async () => {
    const t = testEnv({ upstream: fakePiholes() });
    const res = await call(t.env, "/api/dns");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ setup: true, error: expect.stringContaining("PIHOLE_PASSWORDS") });
    expect(t.calls).toEqual([]);
  });

  it("reaches every Pi-hole by IP over verified HTTPS, never plain HTTP", () => {
    expect(PIHOLES.map((p) => [p.id, p.address.ipv4, p.scheme])).toEqual([
      ["dns7", "192.168.9.3", "https"],
      ["dns8", "192.168.9.7", "https"],
      ["dns9", "100.126.20.101", "https"],
      ["dns10", "100.107.88.15", "https"],
      ["k8s-dns", "192.168.1.16", "https"],
      ["k8s-dns2", "192.168.1.86", "https"],
    ]);
  });
});
