/**
 * UnlinkDialog has no trigger, so it returns focus itself: to the first of
 * `auds` whose Unlink button is still there, else to the page.
 */
export const focusApp = (auds: readonly string[]) => {
  for (const aud of auds) {
    const button = document.querySelector<HTMLElement>(
      `[data-aud="${CSS.escape(aud)}"]`,
    );
    if (button) return button.focus();
  }
  document.getElementById("ob-main")?.focus();
};
