"use strict";
// The toolbar button opens the memo page, or brings an already open one to the front.

const PAGE = chrome.runtime.getURL("app.html");

async function openPage() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [PAGE] });
    const open = contexts.find((c) => c.tabId >= 0);
    if (open) {
      const tab = await chrome.tabs.update(open.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
  } catch (_) {
    // the tab closed meanwhile: open a new one
  }
  await chrome.tabs.create({ url: PAGE });
}

chrome.action.onClicked.addListener(() => { openPage(); });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") openPage();
});
