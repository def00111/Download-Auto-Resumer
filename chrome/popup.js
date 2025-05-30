"use strict";

var saving = false;

function $(id) {
  return document.getElementById(id);
}

function onError(error) {
  alert(error.toString());
  console.error(error);
}

for (const el of document.querySelectorAll("[data-i18n]")) {
  const key = el.getAttribute("data-i18n");
  el.textContent = chrome.i18n.getMessage(key);
}
$("saveButton").value = chrome.i18n.getMessage("save");

chrome.storage.sync.get({
  debug: false,
  time: 30 /* seconds */,
  maxRetries: 10,
  notifyWhenFailed: false,
  resumeOnOnline: false
}).then(prefs => {
  if (prefs.debug) {
    $("debug").checked = true;
  }
  if (prefs.notifyWhenFailed) {
    $("notifyWhenFailed").checked = true;
  }
  if (prefs.resumeOnOnline) {
    $("resumeOnOnline").checked = true;
  }
  $("maxRetries").valueAsNumber = prefs.maxRetries;
  $("time").valueAsNumber = prefs.time;
  $("saveButton").disabled = false;
}).catch(onError);

$("optionsForm").addEventListener("submit", evt => {
  evt.preventDefault();

  if (saving) {
    return;
  }
  saving = true;

  const saveHint = $("saveHint");
  chrome.storage.sync.set({
    debug: $("debug").checked,
    time: $("time").valueAsNumber,
    maxRetries: $("maxRetries").valueAsNumber,
    notifyWhenFailed: $("notifyWhenFailed").checked,
    resumeOnOnline: $("resumeOnOnline").checked
  })
  .then(() => {
    saveHint.classList.remove("hidden");
  })
  .catch(onError)
  .finally(() => {
    setTimeout(() => {
      if (!saveHint.classList.contains("hidden")) {
        saveHint.classList.add("hidden");
      }
      saving = false;
    }, 300);
  });
});
