// Save to Design Vault — sends what you right-click to the local vault app (localhost:5177).
const VAULT = "http://localhost:5177";

async function settings() {
  const s = await chrome.storage.sync.get({ collection: "inspiration", tags: "" });
  return s;
}

function notify(title, message) {
  chrome.notifications.create({ type: "basic", iconUrl: "icon128.png", title, message });
}

async function save(payload) {
  const { collection, tags } = await settings();
  try {
    const r = await fetch(`${VAULT}/api/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collection, tags, ...payload }),
    });
    const j = await r.json();
    notify(j.ok ? "Saved to Design Vault" : "Couldn't save", j.log || "");
    return j;
  } catch (e) {
    notify("Design Vault isn't running", "Open the Design Vault app first, then try again.");
    return { ok: false };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "image", title: "Save image to Design Vault", contexts: ["image"] });
  chrome.contextMenus.create({ id: "video", title: "Save video to Design Vault", contexts: ["video"] });
  chrome.contextMenus.create({ id: "link", title: "Save link to Design Vault", contexts: ["link"] });
  chrome.contextMenus.create({ id: "page", title: "Save this page to Design Vault", contexts: ["page"] });
  chrome.contextMenus.create({ id: "capture", title: "Capture visible area to Design Vault", contexts: ["page", "image"] });
});

async function captureVisible(tab) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  return save({ kind: "image", data_url: dataUrl, page_url: tab.url, title: tab.title });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "image" || info.menuItemId === "video")
    save({ kind: "image", url: info.srcUrl, page_url: tab.url, title: tab.title });
  else if (info.menuItemId === "link") save({ kind: "link", url: info.linkUrl, page_url: tab.url });
  else if (info.menuItemId === "page") save({ kind: "page", url: tab.url, page_url: tab.url, title: tab.title });
  else if (info.menuItemId === "capture") captureVisible(tab);
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === "capture-visible") captureVisible(tab);
  if (command === "save-page") save({ kind: "page", url: tab.url, page_url: tab.url, title: tab.title });
});

// popup asks us to act on the current tab
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
    if (msg.action === "capture") reply(await captureVisible(tab));
    if (msg.action === "page") reply(await save({ kind: "page", url: tab.url, page_url: tab.url, title: tab.title }));
  });
  return true;
});
