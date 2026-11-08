import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { api } from "./api";
import { StatusPage } from "./pages/Status";
import { ArgoPage } from "./pages/Argo";
import { ProxmoxPage } from "./pages/Proxmox";
import { ActionsPage } from "./pages/Actions";
import { AuditPage } from "./pages/Audit";

const NAV = [
  { to: "/", label: "Status", end: true },
  { to: "/argo", label: "Argo CD" },
  { to: "/proxmox", label: "Proxmox" },
  { to: "/actions", label: "Actions" },
  { to: "/audit", label: "Audit" },
];

export function App() {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    api<{ email: string }>("/api/me").then((m) => setEmail(m.email), () => setEmail(null));
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
      <main className="content">
        <Routes>
          <Route path="/" element={<StatusPage />} />
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
