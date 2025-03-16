"use strict";

const continueInterruptReasons = new Set([
  "NETWORK_FAILED",
  "NETWORK_TIMEOUT",
  "NETWORK_SERVER_DOWN",
  "NETWORK_DISCONNECTED",
  "SERVER_CONTENT_LENGTH_MISMATCH",
  "SERVER_UNREACHABLE",
]);

const downloads = new Set();

const prefs = {
  debug: false,
  time: 30 /* seconds */
};

Object.defineProperty(this, "initOptions", {
  value: () => {
    return chrome.storage.sync.get().then(items => {
      Object.assign(prefs, items);
      Object.defineProperty(this, "initOptions", {
        value: Promise.resolve.bind(Promise),
      });
    });
  },
  enumerable: true,
  configurable: true,
});

async function debug(...args) {
  await initOptions();
  if (prefs.debug) {
    console.debug.apply(console, args);
  }
}

function isEnabled() {
  return chrome.storage.session.get({
    enabled: false
  }).then(res => res.enabled);
}

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name.startsWith("dar-alarm-")) {
    let downloadId = parseInt(alarm.name.substr(10), 10);
    if (navigator.onLine) {
      resumeDownload(downloadId);
    }
  }
});

chrome.downloads.onCreated.addListener(async dl => {
  if (dl.state != "in_progress") {
    return;
  }
  if (!(await isEnabled())) {
    toggle(true);
  } else {
    await setTitleAndBadge(await hasDownloads()); // update title and badge
  }
});

chrome.downloads.onErased.addListener(async () => {
  if (!(await hasDownloads())) {
    toggle(false);
  } else {
    await setTitleAndBadge(true); // update title and badge
  }
});

function canResumeDownload(dl) {
  if (dl.state != "interrupted") {
    return false;
  }
  if (!dl.error) {
    return false;
  }
  if (!continueInterruptReasons.has(dl.error)) {
    return false;
  }
  return true;
}

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
  return chrome.downloads.search({
    orderBy: ['-startTime'],
    startedAfter: lastDayDate.toISOString()
  });
}

function checkDownload(dl) {
  return (
    dl.state == "in_progress" && !dl.paused || canResumeDownload(dl)
  );
}

function getDownloads() {
  return searchDownloads().then(dls => dls.filter(checkDownload));
}

function getResumableDownloads() {
  return searchDownloads().then(dls => dls.filter(canResumeDownload));
}

function hasDownloads() {
  return searchDownloads().then(dls => dls.some(checkDownload));
}

chrome.downloads.onChanged.addListener(async delta => {
  if (delta.state?.current == "interrupted") {
    if (!(await hasDownloads())) {
      toggle(false);
    } else {
      await setTitleAndBadge(true); // update title and badge
    }
    if (delta.error &&
        continueInterruptReasons.has(delta.error.current)) {
      handleInterruptedDownload(delta.id);
    }
  } else if (delta.state?.current == "in_progress") {
    if (downloads.has(delta.id)) {
      // Pausing a download causes the "auto_resume_count_" flag to reset when the download is resumed. 
      // https://source.chromium.org/chromium/chromium/src/+/main:components/download/public/common/download_item_impl.h;l=844-847;drc=5f81609f7c343a17175b71d07ae02d6f5d09675f;bpv=0;bpt=1
      chrome.downloads.pause(delta.id).then(() => {
        debug("Paused download %i", delta.id);
      });
    }
    if (!(await isEnabled())) {
      toggle(true);
    } else {
      await setTitleAndBadge(await hasDownloads()); // update title and badge
    }
  } else if (delta.state?.current == "complete") {
    if (!(await hasDownloads())) {
      toggle(false);
    } else {
      await setTitleAndBadge(true); // update title and badge
    }
  } else if ((delta.canResume?.current == true) &&
             downloads.has(delta.id)) {
    chrome.downloads.resume(delta.id).then(() => {
      debug("Resumed download after it was paused %i", delta.id);
      downloads.delete(delta.id);
    });
  } else if (delta.paused &&
             !downloads.has(delta.id)) {
    toggle(await hasDownloads());
  }
});

chrome.storage.sync.onChanged.addListener(async changes => {
  await initOptions();
  const changedItems = Object.keys(changes);
  for (const item of changedItems) {
    prefs[item] = changes[item].newValue;
  }
  if (changedItems.includes("time") &&
      await chrome.alarms.clearAll()) {
    startDownloads();
  }
});

async function handleInterruptedDownload(downloadId) {
  if (!navigator.onLine) {
    return;
  }

  await initOptions();
  chrome.alarms.create(`dar-alarm-${downloadId}`, {
    delayInMinutes: prefs.time / 60
  });
}

async function resumeDownload(downloadId) {
  let [dl] = await chrome.downloads.search({id: downloadId});
  if (dl && canResumeDownload(dl)) {
    chrome.downloads.resume(downloadId).then(async () => {
      debug("Resumed download %i", downloadId);
      downloads.add(downloadId);
    }).catch((error) => {
      console.error("Failed to resume download %i: %s", downloadId, error.message);
      handleInterruptedDownload(downloadId);
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

  const dls = await getDownloads();
  if (dls.length) {
    for (let dl of dls) {
      if (canResumeDownload(dl)) {
        handleInterruptedDownload(dl.id);
      }
    }
    toggle(true);
  }
}

async function setTitleAndBadge(enabled) {
  const {
    setBadgeText: setBadge,
    setTitle
  } = chrome.action;
  const promises = [];
  if (enabled) {
    const dls = await getDownloads();
    let title = `Watching ${dls.length} Download`;
    if (dls.length > 1) {
      title += "s";
    }
    promises.push(
      setTitle({title}),
      setBadge({text: String(dls.length)})
    );
  } else {
    promises.push(
      setTitle({title: ""}),
      setBadge({text: ""})
    );
  }
  return Promise.all(promises);
}

async function toggle(enabled) {
  if (enabled) {
    chrome.power.requestKeepAwake("system");
    await setupOffscreenDocument("offscreen.html");
  } else {
    chrome.power.releaseKeepAwake();
    await chrome.offscreen.closeDocument().catch(() => {});
  }

  await setTitleAndBadge(enabled);
  await chrome.storage.session.set({enabled});
}

let creating;
async function setupOffscreenDocument(path) {
  // Check all windows controlled by the service worker to see if one 
  // of them is the offscreen document with the given path
  const offscreenUrl = chrome.runtime.getURL(path);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length) {
    return;
  }

  try {
    if (creating) {
      await creating;
    } else {
      creating = chrome.offscreen.createDocument({
        url: path,
        reasons: ['WORKERS'],
        justification: 'watch for online/offline events',
      });
      await creating;
      creating = null;
    }
  } catch (ex) {}
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id != chrome.runtime.id) {
    return sendResponse({});
  }

  if (message.online == true) {
    startDownloads();
  } else if (message.offline == true) {
    chrome.alarms.clearAll();
  }
  return sendResponse({});
});

// So the add-on starts correctly
chrome.runtime.onStartup.addListener(() => {});
chrome.runtime.onInstalled.addListener(() => {});

// Initialize
init();
