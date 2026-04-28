/**
 * LocalPass Popup
 *
 * Basic popup that links to options/settings page for configuration.
 */

document.getElementById("open-options")?.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
});
