"use strict";

const prefs = {
  maxRetries: 5,
  retryInterval: 30 /* seconds */,
  notifyWhenFailed: false
};

Object.defineProperty(this, "initOptions", {
  value: () => {
    return browser.storage.sync.get().then(items => {
      Object.assign(prefs, items);
      Object.defineProperty(this, "initOptions", {
        value: Promise.resolve.bind(Promise),
      });
    });
  },
  enumerable: true,
  configurable: true,
});

browser.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name.startsWith("dar-alarm-")) {
    let downloadId = parseInt(alarm.name.substr(10), 10);
    if (navigator.onLine) {
      resumeDownload(downloadId);
    }
  }
});

addEventListener("offline", (event) => {
  browser.alarms.clearAll();
  browser.storage.session.remove("retryCount");
});

addEventListener("online", (event) => {
  startDownloads();
});

async function clearRetries(downloadId) {
  let { retryCount } = await browser.storage.session.get({retryCount: {}});
  if (retryCount[downloadId]) {
    delete retryCount[downloadId];
    await browser.storage.session.set({ retryCount });
  }
}

browser.downloads.onChanged.addListener(async delta => {
  if (delta.state?.current == "interrupted" &&
      delta.error?.current == "NETWORK_FAILED") {
    handleInterruptedDownload(delta.id);
  } else if (delta.state?.current == "complete") {
    clearRetries(delta.id);
  }
});

browser.downloads.onCreated.addListener(async dl => {
  if (dl.state != "in_progress") {
    return;
  }
  let { retryCount } = await browser.storage.session.get({retryCount: {}});
  retryCount[dl.id] = 0;
  await browser.storage.session.set({ retryCount });
});

browser.downloads.onErased.addListener(async downloadId => {
  clearRetries(downloadId);
});

async function startDownloads() {
  if (!navigator.onLine) {
    return;
  }
  for (let dl of await getResumableDownloads()) {
    handleInterruptedDownload(dl.id);
  }
}

function searchDownloads() {
  let lastDayDate = new Date(Date.now() - 24 * 36e5); // limit downloads to the last 24 hours
  return browser.downloads.search({
    orderBy: ['-startTime'],
    startedAfter: lastDayDate.toISOString()
  });
}

function canResumeDownload(dl) {
  return (
    dl.state == "interrupted" && dl.error == "NETWORK_FAILED"
  );
}

function getResumableDownloads() {
  return searchDownloads().then(dls => dls.filter(canResumeDownload));
}

browser.storage.sync.onChanged.addListener(async changes => {
  let changed = false;
  for (const item of Object.keys(changes)) {
    switch (item) {
      case "maxRetries":
        await browser.storage.session.remove("retryCount");
      case "retryInterval":
        changed ||= true;
        break;
    }
  }
  if (changed && await browser.alarms.clearAll()) {
    startDownloads();
  }
});

async function handleInterruptedDownload(downloadId) {
  if (!navigator.onLine) {
    return;
  }
  let { retryCount } = await browser.storage.session.get({retryCount: {}});
  if (!retryCount[downloadId]) {
    retryCount[downloadId] = 0;
  }

  await initOptions();
  if (retryCount[downloadId] < prefs.maxRetries) {
    browser.alarms.create(`dar-alarm-${downloadId}`, {
      delayInMinutes: prefs.retryInterval / 60
    });
  } else if (retryCount[downloadId] == prefs.maxRetries) {
    if (prefs.notifyWhenFailed) {
      await notifyUser("Download failed", `Failed to resume download after ${prefs.maxRetries} attempts.`);
    }
  }
  if (retryCount[downloadId] <= prefs.maxRetries) {
    retryCount[downloadId]++;
  }
  await browser.storage.session.set({ retryCount });
}

async function resumeDownload(downloadId) {
  let [dl] = await browser.downloads.search({id: downloadId});
  if (dl && canResumeDownload(dl)) {
    browser.downloads.resume(downloadId).then(() => {
      console.log("Resumed download %i", downloadId);
    }).catch((error) => {
      console.error("Failed to resume download %i: %s", downloadId, error.message);
    });
  }
}

async function init() {
  const res = await chrome.storage.session.get({
    initialized: false
  });
  if (res.initialized) {
    return;
  }
  await chrome.storage.session.set({
    initialized: true
  });

  startDownloads();
}

function notifyUser(title, message) {
  return browser.notifications.create("dar-notification", {
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/icon-48.png"),
    title,
    message
  });
}

chrome.runtime.onStartup.addListener(() => {});

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason == "install") {
    await chrome.runtime.openOptionsPage();
  }
});

// Initialize
init();
