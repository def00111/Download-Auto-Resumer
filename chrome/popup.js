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
  debug: false,
  time: 30 /* seconds */
}).then(prefs => {
  if (prefs.debug) {
    $("debug").checked = true;
  }
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
    time: $("time").valueAsNumber
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
