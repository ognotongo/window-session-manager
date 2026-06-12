"use strict";

const DEFAULT_OPTIONS = {
  useWindowTitler: true,
  periodicSaveSecs: 30,
  autoTrackNewWindows: false,
};

const useWindowTitler = document.getElementById("useWindowTitler");
const periodicSaveSecs = document.getElementById("periodicSaveSecs");
const autoTrackNewWindows = document.getElementById("autoTrackNewWindows");
const exportBtn = document.getElementById("export");
const importBtn = document.getElementById("import");
const importFile = document.getElementById("import-file");
const ioStatus = document.getElementById("io-status");

async function load() {
  const stored = await browser.storage.local.get("options");
  const options = { ...DEFAULT_OPTIONS, ...(stored.options || {}) };
  useWindowTitler.checked = options.useWindowTitler;
  periodicSaveSecs.value = options.periodicSaveSecs;
  autoTrackNewWindows.checked = options.autoTrackNewWindows;
}

async function save() {
  const options = {
    useWindowTitler: useWindowTitler.checked,
    periodicSaveSecs: Math.max(0, parseInt(periodicSaveSecs.value, 10) || 0),
    autoTrackNewWindows: autoTrackNewWindows.checked,
  };
  await browser.storage.local.set({ options });
}

useWindowTitler.addEventListener("change", save);
periodicSaveSecs.addEventListener("change", save);
autoTrackNewWindows.addEventListener("change", save);

/* ---------------- export / import ---------------- */

function setStatus(text, isError) {
  ioStatus.textContent = text;
  ioStatus.style.color = isError ? "#d7264c" : "";
}

exportBtn.addEventListener("click", async () => {
  try {
    const data = await browser.runtime.sendMessage({ type: "exportSessions" });
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sessions-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setStatus(`Exported ${data.sessions.length} session(s).`, false);
  } catch (e) {
    setStatus(`Export failed: ${e.message}`, true);
  }
});

importBtn.addEventListener("click", () => importFile.click());

importFile.addEventListener("change", async () => {
  const file = importFile.files[0];
  importFile.value = ""; // allow re-selecting the same file
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const result = await browser.runtime.sendMessage({
      type: "importSessions",
      data,
    });
    setStatus(
      `Imported ${result.imported} of ${result.total} session(s) from ${file.name}.`,
      false
    );
  } catch (e) {
    setStatus(`Import failed: ${e.message}`, true);
  }
});

load();
