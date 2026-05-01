// ─── VibeBridge Background Service Worker v14.0 ────────────────────────────────
// Real-time streaming with proper action execution pipeline
//
// v14.0 changes:
// - File-write command results (cat heredoc, sed) inject a short confirmation
//   instead of echoing the full file content back to the AI.
// - file_done SSE event now injects "✓ Written: <path> (<bytes> bytes)" tool_result.
// - command_result for non-write commands unchanged (full output injected).

const DEFAULT_PORT = 3172;
const BRIDGE_URL = () => `http://localhost:${state.port}`;
const SSE_URL = () => `http://localhost:${state.port}/stream`;

let state = {
  port: DEFAULT_PORT,
  connected: false,
  tool: 'vibebridge-v14.0',
  autoApprove: false,
  activeTab: null,
  streamActive: false,
  currentStreamId: null,
  stats: { dispatched: 0, succeeded: 0, failed: 0, chunksReceived: 0, partialBlocks: 0 },
};

// ── File-write command detection ───────────────────────────────────────────────
// Commands that write file content should return a short confirmation, not the
// echoed file body. Matches cat heredoc (> or >>), sed -i, and tee.
const FILE_WRITE_CMD_RE = /^\s*(cat\s+[>]{1,2}|sed\s+-i|tee\s+)/i;

function isFileWriteCommand(cmd) {
  if (!cmd) return false;
  // Check the first non-empty line of a potentially multi-line command
  const firstLine = cmd.trim().split('\n')[0];
  return FILE_WRITE_CMD_RE.test(firstLine);
}

// Extract a short filename from a file-write command for the confirmation message
function extractFilePath(cmd) {
  if (!cmd) return 'file';
  const firstLine = cmd.trim().split('\n')[0];
  // cat > path or cat >> path
  const catMatch = firstLine.match(/cat\s+>{1,2}\s*(\S+)/i);
  if (catMatch) return catMatch[1];
  // sed -i ... path
  const sedMatch = firstLine.match(/sed\s+-i\S*\s+.+?\s+(\S+)$/i);
  if (sedMatch) return sedMatch[1];
  // tee path
  const teeMatch = firstLine.match(/tee\s+(\S+)/i);
  if (teeMatch) return teeMatch[1];
  return 'file';
}

// ── Storage ────────────────────────────────────────────────────────────────────
chrome.storage.local.get(['port', 'autoApprove', 'tool'], (saved) => {
  if (saved.port) state.port = saved.port;
  if (saved.tool) state.tool = saved.tool;
  if (saved.autoApprove !== undefined) state.autoApprove = saved.autoApprove;
  initHealthCheck();
  initSSEConnection();
});

// ── Health Check ────────────────────────────────────────────────────────────────
function initHealthCheck() {
  setInterval(ping, 5000);
  ping();
}

async function ping() {
  try {
    const res = await fetch(`${BRIDGE_URL()}/health`, {
      signal: AbortSignal.timeout(2000)
    });
    const data = await res.json();
    setConnected(true, data.tool || state.tool);
  } catch {
    setConnected(false);
  }
}

function setConnected(connected, toolName) {
  const changed = state.connected !== connected;
  state.connected = connected;
  if (toolName) state.activeTool = toolName;
  if (changed) {
    broadcastStatus();
    updateBadge();
  }
}

function updateBadge() {
  const text = state.connected ? (state.streamActive ? '●' : 'ON') : '';
  const color = state.connected ? (state.streamActive ? '#00ff00' : '#00C896') : '#E24B4A';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ── SSE Connection ─────────────────────────────────────────────────────────────
let eventSource = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;

function initSSEConnection() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  if (!state.connected) {
    setTimeout(initSSEConnection, 5000);
    return;
  }

  try {
    eventSource = new EventSource(SSE_URL());

    eventSource.addEventListener('connected', (e) => {
      const data = JSON.parse(e.data);
      console.log('[VibeBridge] SSE connected, workspace:', data.workspace);
      reconnectAttempts = 0;
    });

    // File chunk - update live
    eventSource.addEventListener('file_chunk', (e) => {
      const data = JSON.parse(e.data);
      state.stats.chunksReceived++;
      broadcastToTabs({
        type: 'VIBE_FILE_CHUNK',
        path: data.path,
        chunk: data.chunk,
        offset: data.offset
      });
    });

    // ── file_done: inject a short write confirmation ───────────────────────────
    // Previously this was silent. Now we inject a tool_result so the AI knows
    // the file landed without seeing the full file content echoed back.
    eventSource.addEventListener('file_done', (e) => {
      const data = JSON.parse(e.data);
      console.log('[VibeBridge] File written:', data.path, data.bytes, 'bytes');

      const confirmText = buildWriteConfirmation(data.path, data.bytes);
      broadcastToTabs({
        type: 'VIBE_INJECT',
        text: confirmText,
        autoSend: true
      });
    });

    // ── command_result: suppress file content, inject short confirmation ───────
    eventSource.addEventListener('command_result', (e) => {
      const data = JSON.parse(e.data);
      const cmd = data.command || '';
      const exitCode = data.exitCode ?? 0;

      let resultText;

      if (isFileWriteCommand(cmd)) {
        // File-write command — never echo the file body back to the AI.
        // Return a short confirmation (or error if it failed).
        if (exitCode === 0) {
          const filePath = extractFilePath(cmd);
          resultText = buildWriteConfirmation(filePath, null, cmd);
        } else {
          // Write failed — DO inject the error so the AI can retry
          resultText = buildErrorResult(cmd, data.output || '', exitCode);
        }
      } else {
        // Normal command — inject full output as before
        resultText = buildCommandResult(cmd, data.output || '', exitCode);
      }

      broadcastToTabs({
        type: 'VIBE_INJECT',
        text: resultText,
        autoSend: true
      });

      console.log('[VibeBridge] Command result injected:', cmd?.slice(0, 50), 'exit:', exitCode,
        isFileWriteCommand(cmd) ? '(write — condensed)' : '');
    });

    // Stream complete
    eventSource.addEventListener('stream_complete', (e) => {
      const data = JSON.parse(e.data);
      console.log('[VibeBridge] Stream complete:', data.actionCount, 'actions,', data.partialBlocks || 0, 'partial blocks');
    });

    // Action result (write_file actions via dispatch, not shell commands)
    eventSource.addEventListener('action_result', (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'write_file') {
        // Already covered by file_done — skip to avoid double injection
        return;
      }
      const resultText = `<tool_result>\n<action>${data.type}</action>\n<status>${data.result?.ok ? 'success' : 'failed'}</status>\n</tool_result>`;
      broadcastToTabs({
        type: 'VIBE_INJECT',
        text: resultText,
        autoSend: true
      });
    });

    eventSource.onerror = () => {
      console.warn('[VibeBridge] SSE error, reconnecting...');
      eventSource.close();
      eventSource = null;

      if (reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        setTimeout(initSSEConnection, 2000 * reconnectAttempts);
      }
    };

  } catch (err) {
    console.error('[VibeBridge] SSE init failed:', err);
    setTimeout(initSSEConnection, 5000);
  }
}

// ── Result builders ────────────────────────────────────────────────────────────

function buildWriteConfirmation(filePath, bytes, cmd) {
  // Determine if this was a create (>) or append (>>) from the command
  let action = 'written';
  if (cmd) {
    if (/cat\s+>>/.test(cmd)) action = 'appended';
    else if (/sed\s+-i/.test(cmd)) action = 'edited';
    else if (/tee\s+/.test(cmd)) action = 'written';
  }
  const sizeStr = bytes != null ? ` (${bytes} bytes)` : '';
  return `<tool_result>\n<status>write successful</status>\n<file>${escapeHtml(filePath)}</file>\n<action>${action}${sizeStr}</action>\n</tool_result>`;
}

function buildCommandResult(cmd, output, exitCode) {
  return `<tool_result>\n<command>${escapeHtml(cmd)}</command>\n<output>${escapeHtml(output)}</output>\n<exit_code>${exitCode}</exit_code>\n</tool_result>`;
}

function buildErrorResult(cmd, output, exitCode) {
  return `<tool_result>\n<command>${escapeHtml(cmd)}</command>\n<error>${escapeHtml(output)}</error>\n<exit_code>${exitCode}</exit_code>\n</tool_result>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Broadcast to all tabs ──────────────────────────────────────────────────────
function broadcastToTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
  });
}

// ── Message Bus ────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'VIBE_STREAM_START') {
    console.log('[VibeBridge] Stream started:', msg.streamId, 'from:', msg.platform);
    state.streamActive = true;
    state.currentStreamId = msg.streamId;
    state.stats.dispatched++;
    updateBadge();
    broadcastStatus();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'VIBE_STREAM_CHUNK') {
    handleStreamChunk(msg.data)
      .then(() => sendResponse({ ok: true }))
      .catch(err => {
        console.warn('[VibeBridge] Chunk forward failed:', err.message);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (msg.type === 'VIBE_STREAM_END') {
    console.log('[VibeBridge] Stream end received, processing...');
    handleStreamEnd(msg)
      .then(() => sendResponse({ ok: true }))
      .catch(err => {
        console.error('[VibeBridge] Stream end error:', err.message);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (msg.type === 'VIBE_INJECT') {
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'VIBE_INJECT',
        text: msg.text,
        autoSend: msg.autoSend !== false
      });
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'VIBE_GET_STATUS') {
    sendResponse({
      connected: state.connected,
      tool: state.activeTool,
      stats: state.stats,
      port: state.port,
      streamActive: state.streamActive,
      platform: sender.tab?.url ? detectPlatform(sender.tab.url) : 'unknown'
    });
    return;
  }

  if (msg.type === 'VIBE_SETTINGS_UPDATE') {
    Object.assign(state, msg.settings);
    chrome.storage.local.set(msg.settings);
    ping();
    sendResponse({ ok: true });
    return;
  }
});

// ── Stream Chunk Handler ──────────────────────────────────────────────────────
async function handleStreamChunk(data) {
  if (!state.connected) throw new Error('VibeBridge not connected');

  try {
    await fetch(`${BRIDGE_URL()}/stream-chunk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        streamId: state.currentStreamId,
        chunk: data.text,
        fullText: data.fullText,
        accumulatedText: data.accumulatedText,
        type: data.type,
        language: data.language,
        timestamp: Date.now()
      }),
      signal: AbortSignal.timeout(5000)
    });
  } catch (err) {
    console.warn('[VibeBridge] Chunk forward failed:', err.message);
    // Don't throw — chunk loss is recoverable
  }
}

// ── Stream End Handler ────────────────────────────────────────────────────────
async function handleStreamEnd(msg) {
  state.streamActive = false;
  updateBadge();

  const { streamId, fullText, source, platform } = msg;
  console.log('[VibeBridge] Processing stream end:', streamId, 'text length:', fullText?.length);

  if (!state.connected) {
    console.log('[VibeBridge] Server not connected, skipping action execution');
    return;
  }

  try {
    const res = await fetch(`${BRIDGE_URL()}/stream-end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        streamId: streamId || state.currentStreamId,
        fullText,
        platform,
        source,
        autoApprove: state.autoApprove
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (!res.ok) throw new Error(`Server error ${res.status}`);

    const result = await res.json();
    console.log('[VibeBridge] Server response:', result.actions?.length || 0, 'actions,', result.partialBlocks || 0, 'partial blocks');

    if (result.partialBlocks > 0) state.stats.partialBlocks += result.partialBlocks;
    if (result.actions?.length > 0) state.stats.succeeded += result.actions.length;

    broadcastStatus();

  } catch (err) {
    state.stats.failed++;
    console.error('[VibeBridge] Stream end failed:', err.message);
    throw err;
  }
}

// ── Platform Detection ────────────────────────────────────────────────────────
function detectPlatform(url) {
  if (!url) return 'unknown';
  if (url.includes('chatgpt.com') || url.includes('openai.com')) return 'chatgpt';
  if (url.includes('anthropic.com') || url.includes('claude.ai')) return 'claude';
  if (url.includes('deepseek.com')) return 'deepseek';
  if (url.includes('gemini') || url.includes('aistudio.google')) return 'gemini';
  if (url.includes('qwen.ai') || url.includes('tongyi')) return 'qwen';
  if (url.includes('moonshot.cn')) return 'moonshot';
  if (url.includes('groq.com')) return 'groq';
  if (url.includes('perplexity.ai')) return 'perplexity';
  return 'unknown';
}

// ── Broadcast Status ──────────────────────────────────────────────────────────
function broadcastStatus() {
  chrome.runtime.sendMessage({
    type: 'VIBE_STATUS',
    connected: state.connected,
    tool: state.activeTool,
    stats: state.stats,
    port: state.port,
    streamActive: state.streamActive
  }).catch(() => {});
}

// ── Tab tracking ─────────────────────────────────────────────────────────────
chrome.tabs.onActivated.addListener(({ tabId }) => { state.activeTab = tabId; });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === 'complete' && tab.active) state.activeTab = tabId;
});

updateBadge();
