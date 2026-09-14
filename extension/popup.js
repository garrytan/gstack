const portInput = document.getElementById('port');
const dot = document.getElementById('dot');
const statusText = document.getElementById('status-text');
const details = document.getElementById('details');
const sidePanelBtn = document.getElementById('side-panel-btn');

// Load saved port
chrome.runtime.sendMessage({ type: 'getPort' }, (resp) => {
  if (resp && resp.port) {
    portInput.value = resp.port;
    updateStatus(resp.connected);
  }
});

// Save port on change
let saveTimeout;
portInput.addEventListener('input', () => {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const port = parseInt(portInput.value, 10);
    if (port > 0 && port < 65536) {
      chrome.runtime.sendMessage({ type: 'setPort', port });
    }
  }, 500);
});

// Listen for health updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'health') {
    updateStatus(!!msg.data, msg.data);
  }
});

function updateStatus(connected, data) {
  dot.className = `dot ${connected ? 'connected' : ''}`;
  statusText.className = `status-text ${connected ? 'connected' : ''}`;
  statusText.textContent = connected ? 'Connected' : 'Disconnected';

  if (connected && data) {
    const parts = [];
    if (data.tabs) parts.push(`${data.tabs} tabs`);
    if (data.mode) parts.push(`Mode: ${data.mode}`);
    details.textContent = parts.join(' \u00b7 ');
  } else {
    details.textContent = '';
  }
}

// Open side panel
sidePanelBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await chrome.sidePanel.open({ tabId: tab.id });
      window.close();
    }
  } catch (err) {
    details.textContent = `Side panel error: ${err.message}`;
  }
});
