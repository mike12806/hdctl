import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { NEW_BUILD_EVENT, api } from "./api";
import { reloadPage } from "./reload";
import { StatusPage } from "./pages/Status";
import { MetricsPage } from "./pages/Metrics";
import { ArgoPage } from "./pages/Argo";
import { ProxmoxPage } from "./pages/Proxmox";
import { ActionsPage } from "./pages/Actions";
import { AuditPage } from "./pages/Audit";

const NAV = [
  { to: "/", label: "Status", end: true },
  { to: "/metrics", label: "Metrics" },
  { to: "/argo", label: "Argo CD" },
  { to: "/proxmox", label: "Proxmox" },
  { to: "/actions", label: "Actions" },
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

  return (
    <div className="shell">
      <nav className="topbar">
        <a className="brand" href="/" aria-label="hdctl home">
          <span className="brand-prompt">❯</span>
          <span className="brand-name">hdctl</span>
          <span className="brand-sub">home data center</span>
        </a>
        <div className="tabs">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `tab${isActive ? " tab-active" : ""}`}>
              {n.label}
            </NavLink>
          ))}
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
          <Route path="/actions" element={<ActionsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="*" element={<StatusPage />} />
        </Routes>
      </main>
    </div>
  );
}
