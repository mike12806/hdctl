import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { UnifiOverview } from "../src/api";
import { UnifiPage } from "../src/pages/Unifi";

beforeAll(() => {
  // jsdom has <dialog> but not always its modal API.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});

const SWITCH = "aa:bb:cc:00:00:02";
const PHONE = "11:22:33:44:55:66";

const overview = (): UnifiOverview => ({
  asOf: Date.now(),
  health: {
    data: {
      subsystems: [
        { name: "wan", status: "ok" },
        { name: "www", status: "warning" },
      ],
      wan: { ip: "203.0.113.7", isp: "Verizon Fios", downloadBps: 940_000, uploadBps: 250_000, availability: 100 },
      gateway: { name: "UDM Pro", version: "4.1.13", cpu: 7, mem: 61, uptime: 86400 },
      internet: { latencyMs: 11, drops: 0 },
      speedtest: { downMbps: 926, upMbps: 951, pingMs: 4, lastRunAt: Date.now() - 3_600_000, running: false },
      clients: { wifi: 43, wired: 50, guests: 0, vpn: 0 },
      devices: { accessPoints: 5, switches: 3, disconnected: 0, pending: 0 },
    },
    error: null,
  },
  devices: {
    data: [
      { mac: "aa:bb:cc:00:00:01", name: "UDM Pro", model: "UDMPRO", kind: "gateway", ip: "192.168.1.1", state: "online", online: true, version: "4.1.13", upgradeTo: null, uptime: 86400, cpu: 7, mem: 61, clients: 90, locating: false, ports: [] },
      {
        mac: SWITCH,
        name: "Core switch",
        model: "USW-24-PoE",
        kind: "switch",
        ip: "192.168.1.2",
        state: "online",
        online: true,
        version: "7.1.26",
        upgradeTo: "7.2.1",
        uptime: 3600,
        cpu: null,
        mem: null,
        clients: 30,
        locating: false,
        ports: [{ idx: 1, name: "AP Office", up: true, speedMbps: 1000, poe: true, poeWatts: 5.4 }],
      },
    ],
    error: null,
  },
  clients: { data: null, error: "UniFi: GET stat/sta -> HTTP 500 api.err.ServerError" },
});

type Call = { url: string; method: string; headers: Headers };

function fakeApi(body: () => UnifiOverview | Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers) });
      if (url === "/api/unifi") {
        const b = body();
        return b instanceof Response ? b : Response.json(b);
      }
      return Response.json({ ok: true });
    }),
  );
  return calls;
}

describe("UniFi page", () => {
  it("shows what the UDM reported, and a failed section as its error with no data", async () => {
    fakeApi(overview);
    render(<UnifiPage />);
    expect(await screen.findByText("7.5 Mbps")).toBeTruthy(); // 940 kB/s down
    expect(screen.getByText("926/951")).toBeTruthy();
    expect(screen.getByText("The UDM reports its WWW as warning.")).toBeTruthy();
    expect(screen.getByText("Core switch")).toBeTruthy();
    expect(screen.getByTitle("Upgrade available: 7.2.1")).toBeTruthy();

    const clients = screen.getByRole("heading", { name: "Clients" }).closest("section")!;
    expect(clients.querySelector("[role=alert]")?.textContent).toContain("HTTP 500 api.err.ServerError");
    expect(clients.querySelector("table")).toBeNull();
  });

  it("restarts a device only after it's confirmed, through the audited same-origin call", async () => {
    const calls = fakeApi(overview);
    render(<UnifiPage />);
    const row = (await screen.findByText("Core switch")).closest("tr")!;
    fireEvent.click(within(row).getByText("Restart"));
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);

    const dialog = document.querySelector("dialog[open]") as HTMLElement;
    expect(dialog.textContent).toContain("Restart Core switch?");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Restart" })));

    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.url)).toEqual([`/api/unifi/devices/${SWITCH}/restart`]);
    expect(posts[0]!.headers.get("X-Hdctl")).toBe("1");
    expect(await screen.findByText("Restart sent to Core switch")).toBeTruthy();
  });

  it("warns that restarting the gateway takes the whole lab offline", async () => {
    fakeApi(overview);
    render(<UnifiPage />);
    const row = (await screen.findByText("UDM Pro", { selector: ".strong" })).closest("tr")!;
    fireEvent.click(within(row).getByText("Restart"));
    expect(document.querySelector("dialog[open]")!.textContent).toContain("the whole lab loses its network");
  });

  it("power-cycles a PoE port after confirmation", async () => {
    const calls = fakeApi(overview);
    render(<UnifiPage />);
    await screen.findByText("Core switch: 1 PoE port");
    fireEvent.click(screen.getByText("Power-cycle"));
    const dialog = document.querySelector("dialog[open]") as HTMLElement;
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Power-cycle" })));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([`/api/unifi/devices/${SWITCH}/ports/1/power-cycle`]);
  });

  it("offers Reconnect for Wi-Fi clients only", async () => {
    const withClients = (): UnifiOverview => ({
      ...overview(),
      clients: {
        data: [
          { mac: "11:22:33:44:55:77", name: "NAS", ip: "192.168.1.50", wired: true, guest: false, network: "Home LAN", via: "Core switch port 2", ssid: null, signal: null, satisfaction: null, uptime: 100, rateBps: 0 },
          { mac: PHONE, name: "phone", ip: "192.168.5.20", wired: false, guest: false, network: "Faherty_IoT", via: "AP Office", ssid: "Faherty", signal: -61, satisfaction: 98, uptime: 600, rateBps: 1500 },
        ],
        error: null,
      },
    });
    const calls = fakeApi(withClients);
    render(<UnifiPage />);
    const nas = (await screen.findByText("NAS", { selector: ".strong" })).closest("tr")!;
    expect(within(nas).queryByText("Reconnect")).toBeNull();
    const phone = screen.getByText("phone", { selector: ".strong" }).closest("tr")!;
    fireEvent.click(within(phone).getByText("Reconnect"));
    const dialog = document.querySelector("dialog[open]") as HTMLElement;
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Reconnect" })));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([`/api/unifi/clients/${PHONE}/reconnect`]);
  });

  it("drops everything when the call fails, rather than keeping the last answer", async () => {
    vi.useFakeTimers();
    let up = true;
    fakeApi(() => (up ? overview() : Response.json({ error: "tunnel down" }, { status: 502 })));
    render(<UnifiPage />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Core switch")).toBeTruthy();

    up = false;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.queryByText("Core switch")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("tunnel down");
  });
});
