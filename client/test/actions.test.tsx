import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Workflow, WorkflowRun } from "../src/api";
import { ActionsPage } from "../src/pages/Actions";

const run = (forge: "github" | "gitea", id: number, repo: string, workflow: string, createdAt: string): WorkflowRun => ({
  forge, id, repo, workflow, workflowId: 1, title: `${workflow} run`, event: "push", status: "completed", conclusion: "success",
  branch: "main", runNumber: id, attempt: 1, createdAt, updatedAt: createdAt, url: `https://example/${forge}/${id}`, actor: null,
});

const GH_RUNS = [run("github", 1, "mike12806/hdctl", "Deploy", "2026-11-09T22:00:00Z")];
const GT_RUNS = [run("gitea", 1, "mike12806/hdc", "renovate-soak", "2026-11-09T22:20:00Z")];
const GH_WF: Workflow[] = [{ forge: "github", repo: "mike12806/hdctl", id: 3, name: "Deploy", file: "deploy.yml", path: ".github/workflows/deploy.yml", url: "https://github.com/x" }];
const GT_WF: Workflow[] = [{ forge: "gitea", repo: "mike12806/hdc", id: "renovate-soak.yml", name: "renovate-soak", file: "renovate-soak.yml", path: ".gitea/workflows/renovate-soak.yml", url: "https://git.mfaherty.net/x" }];

function serve(routes: Record<string, () => Response>) {
  vi.stubGlobal("fetch", vi.fn(async (path: string) => (routes[path] ?? (() => Response.json({ error: "not stubbed" }, { status: 404 })))()));
}

describe("Actions page", () => {
  it("shows GitHub and Gitea runs together, newest first, with Gitea's marked", async () => {
    serve({
      "/api/github/runs": () => Response.json(GH_RUNS),
      "/api/gitea/runs": () => Response.json(GT_RUNS),
      "/api/github/workflows": () => Response.json(GH_WF),
      "/api/gitea/workflows": () => Response.json(GT_WF),
    });
    render(<ActionsPage />);
    const runs = (await screen.findByText("Recent runs")).closest("section")!;
    await within(runs).findByText("Deploy");
    const items = within(runs).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([expect.stringContaining("renovate-soak"), expect.stringContaining("Deploy")]);
    expect(within(items[0]!).getByText("gitea")).toBeTruthy();
    expect(within(items[1]!).queryByText("gitea")).toBeNull();
    expect(screen.getByRole("option", { name: "mike12806/hdc (Gitea)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "mike12806/hdctl (GitHub)" })).toBeTruthy();
  });

  it("keeps GitHub's runs when Gitea fails, and says which one failed", async () => {
    serve({
      "/api/github/runs": () => Response.json(GH_RUNS),
      "/api/gitea/runs": () => Response.json({ error: "Gitea GET /repos/search -> HTTP 500" }, { status: 502 }),
      "/api/github/workflows": () => Response.json(GH_WF),
      "/api/gitea/workflows": () => Response.json(GT_WF),
    });
    render(<ActionsPage />);
    const runs = (await screen.findByText("Recent runs")).closest("section")!;
    await within(runs).findByText("Deploy");
    expect(within(runs).getByRole("alert").textContent).toContain("Gitea GET /repos/search");
    expect(within(runs).getByText("Gitea")).toBeTruthy();
  });
});
