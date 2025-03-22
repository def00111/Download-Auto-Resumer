"use strict";

var saving = false;

function $(id) {
  return document.getElementById(id);
}

function onError(error) {
  alert(error.toString());
  console.error(error);
}

chrome.storage.sync.get({
  maxRetries: 5,
  retryInterval: 30 /* seconds */,
  notifyWhenFailed: false
}).then(prefs => {
  $("maxRetries").valueAsNumber = prefs.maxRetries;
  $("retryInterval").valueAsNumber = prefs.retryInterval;
  if (prefs.notifyWhenFailed) {
    $("notifyWhenFailed").checked = true;
  }
  $("saveButton").disabled = false;
}).catch(onError);

$("optionsForm").addEventListener("submit", evt => {
  evt.preventDefault();

  if (saving) {
    return;
  }
  saving = true;

  chrome.storage.sync.set({
    maxRetries: $("maxRetries").valueAsNumber,
    retryInterval: $("retryInterval").valueAsNumber,
    notifyWhenFailed: $("notifyWhenFailed").checked
  })
  .then(() => {
    $("saveHint").classList.remove("hidden");
  })
  .catch(onError)
  .finally(() => {
    setTimeout(() => {
      if (!$("saveHint").classList.contains("hidden")) {
        $("saveHint").classList.add("hidden");
      }
      saving = false;
    }, 300);
  });
});
