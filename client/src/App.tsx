import { useEffect, useRef, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { NEW_BUILD_EVENT, api } from "./api";
import { reloadPage } from "./reload";
import { StatusPage } from "./pages/Status";
import { MetricsPage } from "./pages/Metrics";
import { ArgoPage } from "./pages/Argo";
import { ProxmoxPage } from "./pages/Proxmox";
import { UnifiPage } from "./pages/Unifi";
import { DnsPage } from "./pages/Dns";
import { KumaPage } from "./pages/Kuma";
import { ActionsPage } from "./pages/Actions";
import { PullsPage } from "./pages/Pulls";
import { AuditPage } from "./pages/Audit";

const NAV = [
  { to: "/", label: "Status", end: true },
  { to: "/metrics", label: "Metrics" },
  { to: "/argo", label: "Argo CD" },
  { to: "/proxmox", label: "Proxmox" },
  { to: "/unifi", label: "UniFi" },
  { to: "/dns", label: "DNS" },
  { to: "/uptime", label: "Uptime" },
  { to: "/actions", label: "Actions" },
  { to: "/pulls", label: "Pull requests" },
  { to: "/audit", label: "Audit" },
];

export function App() {
  const [email, setEmail] = useState<string | null>(null);
  const [newBuild, setNewBuild] = useState(false);
  useEffect(() => {
    api<{ email: string }>("/api/me").then((m) => setEmail(m.email), () => setEmail(null));
  }, []);

  // A deploy happened while this tab was open: reload onto the new bundle,
  // unless a confirmation dialog is open (then ask, so nothing is lost).
  useEffect(() => {
    const onNewBuild = () => {
      if (document.querySelector("dialog[open]")) setNewBuild(true);
      else reloadPage();
    };
    window.addEventListener(NEW_BUILD_EVENT, onNewBuild);
    return () => window.removeEventListener(NEW_BUILD_EVENT, onNewBuild);
  }, []);

  // Back/forward navigation can restore this page from the browser's memory
  // (bfcache) with whatever it showed back then. Reload it instead.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => e.persisted && reloadPage();
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  // On a phone the tabs are a bottom bar that scrolls sideways (styles.css):
  // keep the current page's tab in view, centred, after every navigation,
  // and mark the side(s) with more tabs past the edge so the bar fades there.
  const { pathname } = useLocation();
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = tabsRef.current;
    if (!bar) return;
    const mark = () => {
      const more = bar.scrollWidth - bar.clientWidth;
      bar.toggleAttribute("data-more-left", more > 1 && bar.scrollLeft > 1);
      bar.toggleAttribute("data-more-right", more > 1 && bar.scrollLeft < more - 1);
    };
    mark();
    bar.addEventListener("scroll", mark, { passive: true });
    window.addEventListener("resize", mark);
    return () => {
      bar.removeEventListener("scroll", mark);
      window.removeEventListener("resize", mark);
    };
  }, []);
  useEffect(() => {
    const bar = tabsRef.current;
    const tab = bar?.querySelector<HTMLElement>(".tab-active");
    if (!bar || !tab || bar.scrollWidth <= bar.clientWidth) return;
    const b = bar.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    bar.scrollLeft += t.left + t.width / 2 - (b.left + b.width / 2);
  }, [pathname]);

  return (
    <div className="shell">
      <nav className="topbar">
        <a className="brand" href="/" aria-label="hdctl home">
          <span className="brand-prompt">❯</span>
          <span className="brand-name">hdctl</span>
          <span className="brand-sub">home data center</span>
        </a>
        <div className="tabs-bar">
          <div className="tabs" ref={tabsRef}>
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `tab${isActive ? " tab-active" : ""}`}>
                {n.label}
              </NavLink>
            ))}
          </div>
        </div>
        <div className="whoami" title="Signed in through Cloudflare Access">
          {email ?? ""}
        </div>
      </nav>
      {newBuild && (
        <div className="note note-setup banner" role="status">
          <strong>hdctl was updated</strong>
          <span>Reload to load the new version.</span>
          <button className="btn btn-sm btn-primary" onClick={reloadPage}>
            Reload
          </button>
        </div>
      )}
      <main className="content">
        <Routes>
          <Route path="/" element={<StatusPage />} />
          <Route path="/metrics" element={<MetricsPage />} />
          <Route path="/argo" element={<ArgoPage />} />
          <Route path="/proxmox" element={<ProxmoxPage />} />
          <Route path="/unifi" element={<UnifiPage />} />
          <Route path="/dns" element={<DnsPage />} />
          <Route path="/uptime" element={<KumaPage />} />
          <Route path="/actions" element={<ActionsPage />} />
          <Route path="/pulls" element={<PullsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="*" element={<StatusPage />} />
        </Routes>
      </main>
    </div>
  );
}
