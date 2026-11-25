const VAULT = "http://localhost:5177";
const $ = (id) => document.getElementById(id);

(async () => {
  const s = await chrome.storage.sync.get({ collection: "inspiration", tags: "" });
  $("tags").value = s.tags;
  try {
    const colls = await (await fetch(`${VAULT}/api/collections`)).json();
    $("collection").innerHTML = colls.map((c) => `<option ${c === s.collection ? "selected" : ""}>${c}</option>`).join("");
    $("status").textContent = "Vault is running";
    $("status").className = "ok";
  } catch {
    $("collection").innerHTML = `<option>${s.collection}</option>`;
    $("status").textContent = "Vault isn't running — open the app";
    $("status").className = "down";
  }
})();

$("collection").onchange = () => chrome.storage.sync.set({ collection: $("collection").value });
$("tags").oninput = () => chrome.storage.sync.set({ tags: $("tags").value });

for (const action of ["capture", "page"]) {
  $(action).onclick = async () => {
    $(action).textContent = action === "capture" ? "Capturing…" : "Saving…";
    const r = await chrome.runtime.sendMessage({ action });
    $(action).textContent = r && r.ok ? "Saved ✓" : "Failed";
    setTimeout(() => window.close(), 900);
  };
}
