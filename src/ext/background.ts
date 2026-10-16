// The service worker only opens the side panel from the toolbar button. All agent work runs
// in the panel page while it is open.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
