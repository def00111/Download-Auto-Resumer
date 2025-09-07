"use strict";

const downloads = new Set();

let retryCounts;

const prefs = {
  debug: false,
  time: 30 /* seconds */,
  maxRetries: 10,
  notifyWhenFailed: false,
  resumeOnOnline: false,
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

Object.defineProperty(this, "initRetryCounts", {
  value: () => {
    return chrome.storage.session.get({
      retryCounts: [],
    }).then(res => {
      retryCounts = new Map(res.retryCounts);
      Object.defineProperty(this, "initRetryCounts", {
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
  await initRetryCounts();
  if (retryCounts.has(downloadId)) {
    retryCounts.delete(downloadId);
    await saveRetryCounts();
  }
}

function saveRetryCounts() {
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
    await toggleOffscreenDocument(true);
    toggleKeepAwake(true);
  }
  const dls = await searchDownloads();
  await setTitleAndBadge(getInProgressCount(dls)); // update title and badge
});

chrome.downloads.onErased.addListener(async downloadId => {
  const dls = await searchDownloads();
  const inProgessCount = getInProgressCount(dls);
  if (!inProgessCount && !dls.some(canResumeDownload)) {
    await toggleOffscreenDocument(false);
  }
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
  for (const dl of dls.filter(canResumeDownload)) {
    resumeDownload(dl.id);
  }
}

async function searchDownloads() {
  const date = new Date(Date.now() - 24 * 36e5); // limit downloads to the last 24 hours
  const res = await chrome.storage.session.get({
    startedAfter: date.toISOString()
  });

  const query = Object.assign({
    orderBy: ["-startTime"]
  }, res);

  return chrome.downloads.search(query);
}

function getInProgressCount(dls) {
  let inProgessCount = 0;
  for (let i = dls.length - 1; i >= 0; i--) {
    if (dls[i].state == "in_progress") {
      inProgessCount++;
    }
  }
  return inProgessCount;
}

chrome.downloads.onChanged.addListener(async delta => {
  if (delta.state?.current !== undefined) {
    const dls = await searchDownloads();
    const inProgessCount = getInProgressCount(dls);
    switch (delta.state.current) {
      case "in_progress":
        if (downloads.has(delta.id)) {
          // Pausing a download causes the "auto_resume_count_" flag to reset when the download is resumed. 
          // https://source.chromium.org/chromium/chromium/src/+/main:components/download/public/common/download_item_impl.h;l=844-847;drc=5f81609f7c343a17175b71d07ae02d6f5d09675f;bpv=0;bpt=1
          chrome.downloads.pause(delta.id).then(() => {
            debug("Paused download %i", delta.id);
          });
        }
        if (!(await isEnabled())) {
          await toggleOffscreenDocument(true);
          toggleKeepAwake(true);
        }
        break;
      case "complete":
      case "interrupted":
        if (!inProgessCount && !dls.some(canResumeDownload)) {
          await toggleOffscreenDocument(false);
        }
        if (!inProgessCount) {
          toggleKeepAwake(false);
        }
        if (delta.canResume?.current == true) {
          handleInterruptedDownload(delta.id);
        } else {
          await clearRetries(delta.id);
        }
        break;
    }
    await setTitleAndBadge(inProgessCount); // update title and badge
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
    await createAlarm(`dar-alarm-${downloadId}`);
  } else {
    await initRetryCounts();
    let retryCount = retryCounts.get(downloadId) ?? 0;
    if (retryCount < prefs.maxRetries) {
      await createAlarm(`dar-alarm-${downloadId}`);
    } else if ((retryCount == prefs.maxRetries) &&
                prefs.notifyWhenFailed) {
      await notifyUser(`dar-notification-${downloadId}`, {
        message: prefs.maxRetries > 1
          ? chrome.i18n.getMessage("download_failed2", [prefs.maxRetries])
          : chrome.i18n.getMessage("download_failed1"),
        title: chrome.i18n.getMessage("download_failed_title"),
        buttons: [{
          title: chrome.i18n.getMessage("resume_download_title")
        }]
      });
    }
    if (retryCount <= prefs.maxRetries) {
      retryCounts.set(downloadId, retryCount++);
      await saveRetryCounts();
    }
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

function createAlarm(name) {
  return chrome.alarms.create(name, {
    delayInMinutes: prefs.time / 60
  });
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
  } else if (
    notificationId == "dar-notification" &&
    btnIdx == 0 /* Yes button */
  ) {
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

  let inProgessCount = 0;
  let otherCount = 0;
  let dls = await chrome.downloads.search({
    orderBy: ["-startTime"],
    limit: 0
  });
  dls = dls.filter(dl => {
    if (dl.state == "in_progress" || canResumeDownload(dl)) {
      switch (true) {
        case dl.state == "in_progress":
          inProgessCount++;
          break;
        case canResumeDownload(dl):
          otherCount++;
          break;
      }
      return true;
    }
    return false;
  });
  if (dls.length) {
    const lastDownload = dls[dls.length - 1];
    const startTime = Date.parse(lastDownload.startTime) - 1;
    await chrome.storage.session.set({
      startedAfter: new Date(startTime).toISOString()
    });
    await toggleOffscreenDocument(true);
    if (inProgessCount) {
      await setTitleAndBadge(inProgessCount);
      toggleKeepAwake(true);
    }
    if (otherCount) {
      await notifyUser("dar-notification", {
        requireInteraction: true,
        message: otherCount > 1
          ? chrome.i18n.getMessage("resume_downloads", [otherCount])
          : chrome.i18n.getMessage("resume_download"),
        title: chrome.i18n.getMessage(
          otherCount > 1 ? "resume_downloads_title" : "resume_download_title"
        ),
        buttons: [{
          title: chrome.i18n.getMessage("yes")
        }, {
          title: chrome.i18n.getMessage("no")
        }]
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
    promises.push(
      setTitle({
        title: count > 1
          ? chrome.i18n.getMessage("watching_downloads", [count])
          : chrome.i18n.getMessage("watching_download")
      }),
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

function toggleKeepAwake(enabled) {
  if (enabled) {
    chrome.power.requestKeepAwake("system");
  } else {
    chrome.power.releaseKeepAwake();
  }
}

let creating;
async function toggleOffscreenDocument(enabled) {
  // Check all windows controlled by the service worker to see if one 
  // of them is the offscreen document with the given path
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const [existingContext] = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });

  if (existingContext) {
    if (!enabled) {
      await chrome.offscreen.closeDocument();
    }
    return chrome.storage.session.set({enabled});
  }

  if (enabled) {
    try {
      if (creating) {
        await creating;
      } else {
        // Workaround for bug: https://issues.chromium.org/issues/40155587
        creating = chrome.offscreen.createDocument({
          url: offscreenUrl,
          reasons: ['WORKERS'],
          justification: 'Watch for online/offline events',
        });
        await creating;
        creating = null;
      }
    } catch (ex) {}
  }
  return chrome.storage.session.set({enabled});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id != chrome.runtime.id) {
    return sendResponse({});
  }

  if (message.online == true) {
    initOptions().then(async () => {
      if (prefs.resumeOnOnline) {
        await startDownloads();
      }
      sendResponse({});
    });
  } else if (message.offline == true) {
    chrome.alarms.clearAll().then(() => sendResponse({}));
  }
  return true;
});

// So the add-on starts correctly
chrome.runtime.onStartup.addListener(() => {});
chrome.runtime.onInstalled.addListener(() => {});

// Initialize
init();
