import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PullRequest } from "../src/api";
import { PullsPage } from "../src/pages/Pulls";

const pr = (over: Partial<PullRequest>): PullRequest => ({
  forge: "github", repo: "mike12806/hdctl", number: 1, title: "A change", url: "https://github.com/x", author: "mike12806", draft: false,
  createdAt: "2026-11-09T20:00:00Z", updatedAt: "2026-11-09T20:00:00Z", head: "feat/x", headSha: "a".repeat(40), base: "main",
  labels: [], checks: "success", mergeable: "yes", review: null, ...over,
});

function serve(gh: () => Response, gt: () => Response) {
  const calls: { path: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === "/api/pulls/github") return gh();
      if (path === "/api/pulls/gitea") return gt();
      return Response.json({ merged: true });
    }),
  );
  // jsdom has no <dialog> modal support.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  return calls;
}

describe("Pull requests page", () => {
  it("lists GitHub's and Gitea's open pull requests together, newest first, with their state", async () => {
    serve(
      () => Response.json([pr({ number: 30, title: "Live Kuma", updatedAt: "2026-11-09T21:00:00Z", checks: "failure", mergeable: "conflict" })]),
      () => Response.json([pr({ forge: "gitea", repo: "mike12806/hdc", number: 7517, title: "chore(deps)", updatedAt: "2026-11-09T22:00:00Z", checks: "pending", labels: ["renovate"] })]),
    );
    render(<PullsPage />);
    await screen.findByText("Live Kuma");
    const items = screen.getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("chore(deps)");
    expect(within(items[0]!).getByText("gitea")).toBeTruthy();
    expect(within(items[0]!).getByText("checks running")).toBeTruthy();
    expect(within(items[0]!).getByText("renovate")).toBeTruthy();
    expect(within(items[1]!).getByText("checks fail")).toBeTruthy();
    expect(within(items[1]!).getByText("conflicts")).toBeTruthy();
    expect((within(items[1]!).getByRole("button", { name: "Merge…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("merges the head commit shown, after confirming", async () => {
    const calls = serve(() => Response.json([pr({ number: 31 })]), () => Response.json([]));
    render(<PullsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Merge…" }));
    expect(screen.getByText(/Merges commit/).textContent).toContain("aaaaaaa");
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/pulls/github/mike12806/hdctl/31/merge")).toBe(true));
    const merge = calls.find((c) => c.path.endsWith("/merge"))!;
    expect(JSON.parse(String(merge.init?.body))).toEqual({ sha: "a".repeat(40) });
  });

  it("keeps Gitea's pull requests when GitHub fails, and says which one failed", async () => {
    serve(() => Response.json({ error: "GitHub GraphQL: rate limited" }, { status: 502 }), () => Response.json([pr({ forge: "gitea", repo: "mike12806/hdc", number: 5, title: "Gitea one" })]));
    render(<PullsPage />);
    await screen.findByText("Gitea one");
    expect(screen.getByRole("alert").textContent).toContain("rate limited");
    expect(screen.getByText("GitHub")).toBeTruthy();
  });
});
