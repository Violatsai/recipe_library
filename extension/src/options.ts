import { DEFAULT_API_BASE, getSettings, setSettings } from "./shared.js";

const apiBaseEl = document.getElementById("apiBase") as HTMLInputElement;
const apiKeyEl = document.getElementById("apiKey") as HTMLInputElement;
const saveEl = document.getElementById("save") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;

void (async () => {
  const s = await getSettings();
  apiBaseEl.value = s.apiBase;
  apiKeyEl.value = s.apiKey;

  saveEl.addEventListener("click", () => {
    void (async () => {
      await setSettings({
        apiBase: apiBaseEl.value.trim() || DEFAULT_API_BASE,
        apiKey: apiKeyEl.value.trim(),
      });
      statusEl.textContent = "Saved ✓";
      setTimeout(() => (statusEl.textContent = ""), 2000);
    })();
  });
})();
