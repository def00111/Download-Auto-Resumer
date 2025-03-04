addEventListener("offline", (event) => {
  chrome.runtime.sendMessage({offline: true});
});

addEventListener("online", (event) => {
  chrome.runtime.sendMessage({online: true});
});
