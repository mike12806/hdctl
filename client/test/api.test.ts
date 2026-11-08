import { describe, expect, it, vi } from "vitest";
import { NEW_BUILD_EVENT, api, post } from "../src/api";

function stubFetch(answer: () => Response | Promise<Response>) {
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => answer());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("api()", () => {
  it("never takes an answer from the browser's cache, and marks the call as the app's", async () => {
    const fetch = stubFetch(() => Response.json({}));
    await api("/api/status");
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe("/api/status");
    expect(init).toMatchObject({ cache: "no-store", credentials: "same-origin" });
    expect(new Headers(init!.headers).get("X-Hdctl")).toBe("1");
  });

  it("posts JSON", async () => {
    const fetch = stubFetch(() => Response.json({ upid: "UPID" }));
    expect(await post("/api/proxmox/pve/pve/qemu/1/reboot", { a: 1 })).toEqual({ upid: "UPID" });
    const init = fetch.mock.calls[0]![1]!;
    expect(init).toMatchObject({ method: "POST", body: '{"a":1}' });
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("announces a deploy when the Worker reports another build, on success or error", async () => {
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(NEW_BUILD_EVENT, listener);
    try {
      stubFetch(() => Response.json({}, { headers: { "X-Hdctl-Build": "newer" } }));
      await api("/api/me");
      stubFetch(() => Response.json({ error: "down" }, { status: 502, headers: { "X-Hdctl-Build": "newest" } }));
      await api("/api/me").catch(() => {});
      stubFetch(() => Response.json({}, { headers: { "X-Hdctl-Build": __HDCTL_BUILD__ } }));
      await api("/api/me");
      stubFetch(() => Response.json({}));
      await api("/api/me");
    } finally {
      window.removeEventListener(NEW_BUILD_EVENT, listener);
    }
    expect(seen).toEqual(["newer", "newest"]);
  });

  it("raises the Worker's error message, and whether it's a setup problem", async () => {
    stubFetch(() => Response.json({ error: "ARGOCD_TOKEN is not set", setup: true }, { status: 503 }));
    await expect(api("/api/argo/apps")).rejects.toMatchObject({ status: 503, setup: true, message: "ARGOCD_TOKEN is not set" });
    stubFetch(() => Response.json({ error: "Argo CD GET -> HTTP 500" }, { status: 502 }));
    await expect(api("/api/argo/apps")).rejects.toMatchObject({ status: 502, setup: false });
  });

  it("explains a failed fetch as a probably expired session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(api("/api/me")).rejects.toMatchObject({ status: 0, message: expect.stringContaining("reload the page") });
  });
});
