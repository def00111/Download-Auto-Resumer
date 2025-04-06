"use strict";

const downloads = new Set();

let retryCounts;

const prefs = {
  debug: false,
  time: 30 /* seconds */,
  maxRetries: 10,
  notifyWhenFailed: false
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

async function clearRetries(downloadId) {
  if (retryCounts === undefined) {
    retryCounts = await getRetryCounts();
  }
  if (retryCounts.has(downloadId)) {
    retryCounts.delete(downloadId);
    await setRetryCounts();
  }
}

function getRetryCounts() {
  return chrome.storage.session.get({
    retryCounts: []
  }).then(res => new Map(res.retryCounts));
}

function setRetryCounts() {
  return chrome.storage.session.set({
    retryCounts: Array.from(retryCounts)
  });
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name.startsWith("dar-alarm-")) {
    const downloadId = parseInt(alarm.name.substr(10), 10);
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
    await toggle(true);
    toggleKeepAwake(true);
  }
  const dls = await searchDownloads();
  await setTitleAndBadge(getInProgressCount(dls)); // update title and badge
});

chrome.downloads.onErased.addListener(async downloadId => {
  const dls = await searchDownloads();
  if (!hasDownloads(dls)) {
    await toggle(false);
  }
  const inProgessCount = getInProgressCount(dls);
  if (!inProgessCount) {
    toggleKeepAwake(false);
  }
  await setTitleAndBadge(inProgessCount); // update title and badge
  await clearRetries(downloadId);
});

function canResumeDownload(dl) {
  if (dl.state != "interrupted") {
    return false;
  }
  return dl.canResume;
}

async function startDownloads() {
  if (!navigator.onLine) {
    return;
  }
  const dls = await searchDownloads();
  for (let i = 0, l = dls.length; i < l; i++) {
    if (canResumeDownload(dls[i])) {
      resumeDownload(dls[i].id);
    }
  }
}

async function searchDownloads() {
  const lastDayDate = new Date(Date.now() - 24 * 36e5); // limit downloads to the last 24 hours
  const res = await chrome.storage.session.get({
    startedAfter: lastDayDate.toISOString()
  });

  const query = Object.assign({
    orderBy: ["-startTime"]
  }, res);

  return chrome.downloads.search(query);
}

function checkDownload(dl) {
  return dl.state == "in_progress" || canResumeDownload(dl);
}

function getInProgressCount(dls) {
  let inProgessCount = 0;
  for (let i = 0, l = dls.length; i < l; i++) {
    if (dls[i].state == "in_progress") {
      inProgessCount++;
    }
  }
  return inProgessCount;
}

function hasDownloads(dls) {
  for (let i = 0, l = dls.length; i < l; i++) {
    if (checkDownload(dls[i])) {
      return true;
    }
  }
  return false;
}

chrome.downloads.onChanged.addListener(async delta => {
  if (delta.state?.current == "interrupted") {
    const dls = await searchDownloads();
    if (!hasDownloads(dls)) {
      await toggle(false);
    }
    const inProgessCount = getInProgressCount(dls);
    if (!inProgessCount) {
      toggleKeepAwake(false);
    }
    await setTitleAndBadge(inProgessCount); // update title and badge
    if (delta.canResume?.current == true) {
      handleInterruptedDownload(delta.id);
    } else {
      await clearRetries(delta.id);
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
      await toggle(true);
      toggleKeepAwake(true);
    } 
    const dls = await searchDownloads();
    await setTitleAndBadge(getInProgressCount(dls)); // update title and badge
  } else if (delta.state?.current == "complete") {
    const dls = await searchDownloads();
    if (!hasDownloads(dls)) {
      await toggle(false);
    }
    const inProgessCount = getInProgressCount(dls);
    if (!inProgessCount) {
      toggleKeepAwake(false);
    }
    await setTitleAndBadge(inProgessCount); // update title and badge
    await clearRetries(delta.id);
  } else if ((delta.canResume?.current == true) &&
             downloads.has(delta.id)) {
    chrome.downloads.resume(delta.id).then(() => {
      debug("Resumed download after it was paused %i", delta.id);
      downloads.delete(delta.id);
    });
  }
});

chrome.storage.sync.onChanged.addListener(async changes => {
  await initOptions();
  const changedItems = Object.keys(changes);
  for (const item of changedItems) {
    prefs[item] = changes[item].newValue;
  }

  let changed = false;
  for (const item of changedItems) {
    switch (item) {
      case "maxRetries":
        await chrome.storage.session.remove("retryCounts");
      case "time":
        changed ||= true;
        break;
    }
  }
  if (changed) {
    const wasCleared = await chrome.alarms.clearAll();
    if (wasCleared) {
      await startDownloads();
    }
  }
});

async function handleInterruptedDownload(downloadId) {
  if (!navigator.onLine) {
    return;
  }

  await initOptions();
  if (!prefs.maxRetries) {
    await chrome.alarms.create(`dar-alarm-${downloadId}`, {
      delayInMinutes: prefs.time / 60
    });
  } else {
    if (retryCounts === undefined) {
      retryCounts = await getRetryCounts();
    }
    let retryCount = retryCounts.get(downloadId) ?? 0;
    if (retryCount < prefs.maxRetries) {
      await chrome.alarms.create(`dar-alarm-${downloadId}`, {
        delayInMinutes: prefs.time / 60
      });
    } else if ((retryCount == prefs.maxRetries) &&
                prefs.notifyWhenFailed) {
      await notifyUser(`dar-notification-${downloadId}`, {
        message: `Failed to resume download after ${prefs.maxRetries} attempts.`,
        title: "Download failed",
        buttons: [{title: "Resume Download"}]
      });
    }
    if (retryCount <= prefs.maxRetries) {
      retryCounts.set(downloadId, retryCount++);
    }
    await setRetryCounts();
  }
}

async function resumeDownload(downloadId) {
  let [dl] = await chrome.downloads.search({id: downloadId});
  if (dl && canResumeDownload(dl)) {
    chrome.downloads.resume(downloadId).then(() => {
      debug("Resumed download %i", downloadId);
      downloads.add(downloadId);
    }).catch(error => {
      console.error("Failed to resume download %i: %s", downloadId, error.message);
    });
  }
}

function notifyUser(notificationId, options) {
  Object.assign(options, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-48.png")
  });
  return chrome.notifications.create(notificationId, options);
}

chrome.notifications.onButtonClicked.addListener(async (notificationId, btnIdx) => {
  if (notificationId.startsWith("dar-notification-")) {
    const downloadId = parseInt(notificationId.substr(17), 10);
    await clearRetries(downloadId);
    resumeDownload(downloadId);
  } else if (notificationId == "dar-notification" && btnIdx == 0) {
    await startDownloads();
  }
});

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

  let dls = await chrome.downloads.search({
    orderBy: ["-startTime"],
    limit: 0
  });
  dls = dls.filter(checkDownload);
  if (dls.length) {
    const lastDownload = dls[dls.length - 1];
    const startTime = Date.parse(lastDownload.startTime) - 1;
    await chrome.storage.session.set({
      startedAfter: new Date(startTime).toISOString()
    });
    await toggle(true);
    const inProgessDls = dls.filter(dl => dl.state == "in_progress");
    if (inProgessDls.length) {
      await setTitleAndBadge(inProgessDls.length);
      toggleKeepAwake(true);
    }
    const otherDls = dls.filter(canResumeDownload);
    if (otherDls.length) {
      let message = `Do you want to resume ${otherDls.length} failed Download`;
      if (otherDls.length > 1) {
        message += "s";
      }
      message += "?";
      await notifyUser("dar-notification", {
        requireInteraction: true,
        message,
        title: "Resume Downloads",
        buttons: [{title: "Yes"}, {title: "No"}]
      });
    }
  }
}

function setTitleAndBadge(count) {
  const {
    setBadgeText: setBadge,
    setTitle
  } = chrome.action;
  const promises = [];
  if (count) {
    let title = `Watching ${count} Download`;
    if (count > 1) {
      title += "s";
    }
    promises.push(
      setTitle({title}),
      setBadge({text: String(count)})
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
    await setupOffscreenDocument("offscreen.html");
  } else {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  await chrome.storage.session.set({enabled});
}

async function toggleKeepAwake(enabled) {
  if (enabled) {
    chrome.power.requestKeepAwake("system");
  } else {
    chrome.power.releaseKeepAwake();
  }
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
