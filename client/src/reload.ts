/** Reload the page onto the current deploy. Its own module so tests can stand in for it (jsdom can't navigate). */
export function reloadPage(): void {
  window.location.reload();
}
