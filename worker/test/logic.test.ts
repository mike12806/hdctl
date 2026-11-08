import { describe, expect, it } from "vitest";
import { classify } from "../src/health";
import { TARGETS, targetById } from "../src/targets";
import { dispatchInputs } from "../src/integrations/github";
import { parseGuestRef } from "../src/integrations/proxmox";
import { assertAppName } from "../src/integrations/argo";
import { BadRequest } from "../src/errors";

describe("target catalog", () => {
  it("has unique ids and bindings, and a VPC service for every target", () => {
    expect(new Set(TARGETS.map((t) => t.id)).size).toBe(TARGETS.length);
    expect(new Set(TARGETS.map((t) => t.binding)).size).toBe(TARGETS.length);
    for (const t of TARGETS) expect(t.serviceId, t.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reaches every non-cluster target by IP, so no internal DNS is involved", () => {
    for (const t of TARGETS.filter((t) => t.group !== "cluster")) expect(t.address.ipv4, t.id).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});

describe("classify", () => {
  const harbor = targetById("harbor")!;
  const vault = targetById("vault-1")!;

  it("is up on an expected code", () => {
    expect(classify(harbor, { code: 200 }, 40)).toMatchObject({ state: "up", code: 200, latencyMs: 40 });
  });
  it("is degraded when slow, or on an unexpected 4xx", () => {
    expect(classify(harbor, { code: 200 }, 4_500).state).toBe("degraded");
    expect(classify(harbor, { code: 404 }, 10)).toMatchObject({ state: "degraded", detail: "HTTP 404, expected 200" });
  });
  it("is down on a 5xx or no answer", () => {
    expect(classify(harbor, { code: 502 }, 10).state).toBe("down");
    expect(classify(harbor, { error: "connection refused" }, 0)).toMatchObject({ state: "down", detail: "connection refused" });
  });
  it("reads Vault's health codes", () => {
    expect(classify(vault, { code: 200 }, 5)).toMatchObject({ state: "up", detail: "active" });
    expect(classify(vault, { code: 429 }, 5)).toMatchObject({ state: "up", detail: "standby" });
    expect(classify(vault, { code: 503 }, 5)).toMatchObject({ state: "down", detail: "sealed" });
  });
});

describe("dispatchInputs", () => {
  it("returns null without a workflow_dispatch trigger", () => {
    expect(dispatchInputs("on:\n  push:\n    branches: [main]\njobs: {}\n")).toBeNull();
    expect(dispatchInputs("on: push\n")).toBeNull();
  });
  it("handles the string and list forms", () => {
    expect(dispatchInputs("on: workflow_dispatch\n")).toEqual([]);
    expect(dispatchInputs("on: [push, workflow_dispatch]\n")).toEqual([]);
    expect(dispatchInputs("on:\n  workflow_dispatch:\n")).toEqual([]);
  });
  it("reads typed inputs", () => {
    const yaml = `
on:
  workflow_dispatch:
    inputs:
      action:
        description: plan or apply
        type: choice
        options: [plan, apply]
        default: plan
      apply:
        type: boolean
        default: false
      gh_hdc_ref:
        required: true
`;
    expect(dispatchInputs(yaml)).toEqual([
      { name: "action", description: "plan or apply", type: "choice", required: false, default: "plan", options: ["plan", "apply"] },
      { name: "apply", description: null, type: "boolean", required: false, default: false, options: [] },
      { name: "gh_hdc_ref", description: null, type: "string", required: true, default: null, options: [] },
    ]);
  });
});

describe("parseGuestRef", () => {
  const ok = { host: "pve4", node: "pve", type: "qemu", vmid: "101", action: "reboot" };
  it("accepts a valid reference, addressing pve4 by host even though its node is called pve", () => {
    const g = parseGuestRef(ok);
    expect(g.host.id).toBe("pve4");
    expect(g.host.address.ipv4).toBe("192.168.1.12");
    expect(g.vmid).toBe(101);
  });
  it.each([
    { host: "harbor" },
    { host: "nope" },
    { node: "../etc" },
    { type: "storage" },
    { vmid: "1; rm" },
    { action: "stop" },
    { action: "destroy" },
  ])("rejects %o", (bad) => {
    expect(() => parseGuestRef({ ...ok, ...bad })).toThrow(BadRequest);
  });
});

describe("assertAppName", () => {
  it("allows Argo app names and refuses path tricks", () => {
    expect(assertAppName("redpanda-connect-es")).toBe("redpanda-connect-es");
    expect(() => assertAppName("../settings")).toThrow(BadRequest);
    expect(() => assertAppName("Upper")).toThrow(BadRequest);
  });
});
