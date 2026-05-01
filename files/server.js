#!/usr/bin/env node
// ─── VibeBridge Server v14.1 ────────────────────────────────────────────────────
// Real-time streaming server with complete action execution
//
// CHANGES v14.1:
// - ALL commands: removed hardcoded timeouts; spawnSync waits for natural exit
// - pip/python/general dedup: only blocks retries after SUCCESS — failed runs always retryable
// - python3 app.py / -m uvicorn / -m flask etc: spawned in background (no timeout)
//   Returns PID + startup output after 3s; agent continues immediately.
//   Kill via POST /kill-process {"label":"<cmd>"} or GET /processes to list running.
//
// CHANGES v14.0:
// - File write methods: ONLY cat heredoc and sed heredoc (FILENAME block removed)
// - Workspace is now the ROOT directory (process.cwd()) — no /workspace subfolder
// - Creates .gitignore at root listing all server/extension files on first run
// - Pip double-execution guardrail: pip/pip3 commands deduplicated within 120s window
// - System prompt injected from chrome-extension/prompt.md (not hardcoded)
// - Multi-agent support: orchestrator + specialist agent roles

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync, spawn } = require('child_process');
const readline = require('readline');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i !== -1 && args[i+1] ? args[i+1] : def; };
const hasFlag = flag => args.includes(flag);

const PORT = parseInt(getArg('--port', '3172'), 10);
// Default: parent of server.js (vibebridge-final/) so files land in your project root
const BASE_DIR = path.resolve(getArg('--dir', path.join(__dirname, '..')));
const AUTO_APPROVE = hasFlag('--auto-approve');
const VERSION = '14.1.0-wsl';

// ── Root Workspace (NO /workspace subfolder) ──────────────────────────────────
// Files are written directly into BASE_DIR (the directory where server runs).
// On first boot, write a .gitignore that excludes VibeBridge's own files.
const WORKSPACE = BASE_DIR;

const GITIGNORE_ENTRIES = [
  'server.js',
  'package.json',
  'package-lock.json',
  'node_modules/',
  '.vibeignore',
  'README.md',
  'CODE_EXPLANATION.md',
  'chrome-extension/',
  'background.js',
  'manifest.json',
  'popup.html',
  'popup.js',
  'core.js',
  'content-scripts/',
  'prompt.md',
  'VIBEBRIDGE_SYSTEM_PROMPT.md',
];

function ensureGitignore() {
  const gitignorePath = path.join(WORKSPACE, '.gitignore');
  const marker = '# vibebridge-managed';
  if (fs.existsSync(gitignorePath)) {
    const existing = fs.readFileSync(gitignorePath, 'utf8');
    if (existing.includes(marker)) return; // already set up
    // Append to existing
    const addition = '\n' + marker + '\n' + GITIGNORE_ENTRIES.join('\n') + '\n';
    fs.appendFileSync(gitignorePath, addition);
  } else {
    const content = marker + '\n' + GITIGNORE_ENTRIES.join('\n') + '\n';
    fs.writeFileSync(gitignorePath, content);
  }
  log('.gitignore updated with VibeBridge entries', C.green);
}

const SERVER_IGNORES = new Set([
  'server.js', 'package.json', 'package-lock.json', 'node_modules',
  '.vibeignore', 'README.md', 'CODE_EXPLANATION.md',
  'chrome-extension', 'background.js', 'manifest.json',
  'popup.html', 'popup.js', 'core.js', 'content-scripts',
  'prompt.md', 'VIBEBRIDGE_SYSTEM_PROMPT.md',
]);

// ── Colors ───────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m',
  yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
  bold: '\x1b[1m', magenta: '\x1b[35m'
};

function ts() { return new Date().toISOString().substr(11, 8); }
function log(msg, color = C.reset) {
  process.stdout.write(`${C.dim}[${ts()}]${C.reset} ${color}${msg}${C.reset}\n`);
}

// ── Stats ─────────────────────────────────────────────────────────────────────
const stats = {
  dispatched: 0,
  succeeded: 0,
  failed: 0,
  streamsReceived: 0,
  chunksReceived: 0,
  partialBlocks: 0,
  skippedDuplicates: 0,
  skippedPipDuplicates: 0,
  skippedPythonDuplicates: 0,
};

// ── Background Process Registry ───────────────────────────────────────────────
// Tracks long-running spawned processes (e.g. python3 app.py) by a short label.
// Key: label (command slug). Value: { pid, proc, command, startTime }.
const bgProcesses = new Map();

// ── Executed Command Dedup ────────────────────────────────────────────────────
const executedCommandHashes = new Map(); // hash → { count, firstRun }
const DEDUP_WINDOW_MS = 60_000;

// ── Pip Dedup — only blocks retries after a SUCCESSFUL install ────────────────
// A failed pip run must always be retryable (network blip, partial download, etc).
// Key: normalized command. Value: { count, firstRun, succeeded }.
const executedPipCommands = new Map();
const PIP_DEDUP_WINDOW_MS = 120_000;
const PIP_CMD_RE = /^\s*pip3?\s+install\b/i;

function isPipCommand(cmd) {
  return PIP_CMD_RE.test(cmd.trim().split('\n')[0]);
}

function isDuplicatePip(cmd) {
  if (!isPipCommand(cmd)) return false;
  const key = cmd.trim().replace(/\s+/g, ' ').toLowerCase();
  const now = Date.now();
  const entry = executedPipCommands.get(key);
  // Only block if a previous run SUCCEEDED within the window
  if (entry && entry.succeeded && (now - entry.firstRun) < PIP_DEDUP_WINDOW_MS) {
    entry.count++;
    stats.skippedPipDuplicates++;
    log(`  ⛔ pip dedup (already succeeded, ${entry.count}x): ${cmd.slice(0, 60)}`, C.yellow);
    return true;
  }
  // Register or overwrite so a retry can proceed
  executedPipCommands.set(key, { count: 1, firstRun: now, succeeded: false });
  for (const [k, v] of executedPipCommands) {
    if ((now - v.firstRun) > PIP_DEDUP_WINDOW_MS) executedPipCommands.delete(k);
  }
  return false;
}

function markPipSucceeded(cmd) {
  if (!isPipCommand(cmd)) return;
  const key = cmd.trim().replace(/\s+/g, ' ').toLowerCase();
  const entry = executedPipCommands.get(key);
  if (entry) entry.succeeded = true;
}

// ── Python Dedup — only blocks retries after a SUCCESSFUL run ─────────────────
// Failed python runs are always retryable.
const executedPythonCommands = new Map();
const PYTHON_DEDUP_WINDOW_MS = 120_000;
const PYTHON_CMD_RE = /^\s*python3?\s+/i;

function isPythonCommand(cmd) {
  return PYTHON_CMD_RE.test(cmd.trim().split('\n')[0]);
}

function isDuplicatePython(cmd) {
  if (!isPythonCommand(cmd)) return false;
  const key = cmd.trim().replace(/\s+/g, ' ').toLowerCase();
  const now = Date.now();
  const entry = executedPythonCommands.get(key);
  if (entry && entry.succeeded && (now - entry.firstRun) < PYTHON_DEDUP_WINDOW_MS) {
    entry.count++;
    log(`  ⛔ python dedup (already succeeded, ${entry.count}x): ${cmd.slice(0, 60)}`, C.yellow);
    return true;
  }
  executedPythonCommands.set(key, { count: 1, firstRun: now, succeeded: false });
  for (const [k, v] of executedPythonCommands) {
    if ((now - v.firstRun) > PYTHON_DEDUP_WINDOW_MS) executedPythonCommands.delete(k);
  }
  return false;
}

function markPythonSucceeded(cmd) {
  if (!isPythonCommand(cmd)) return;
  const key = cmd.trim().replace(/\s+/g, ' ').toLowerCase();
  const entry = executedPythonCommands.get(key);
  if (entry) entry.succeeded = true;
}

// ── General Command Dedup — only blocks after SUCCESS ─────────────────────────
function hashCommand(cmd) {
  let h = 5381;
  for (let i = 0; i < cmd.length; i++) h = ((h << 5) + h) ^ cmd.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function isDuplicateCommand(cmd) {
  const h = hashCommand(cmd);
  const now = Date.now();
  const entry = executedCommandHashes.get(h);
  // Only block if the previous run SUCCEEDED within the window
  if (entry && entry.succeeded && (now - entry.firstRun) < DEDUP_WINDOW_MS) {
    entry.count++;
    return true;
  }
  // Register or overwrite (allow retry of failed commands)
  executedCommandHashes.set(h, { count: 1, firstRun: now, succeeded: false });
  for (const [k, v] of executedCommandHashes) {
    if ((now - v.firstRun) > DEDUP_WINDOW_MS) executedCommandHashes.delete(k);
  }
  return false;
}

function markCommandSucceeded(cmd) {
  const h = hashCommand(cmd);
  const entry = executedCommandHashes.get(h);
  if (entry) entry.succeeded = true;
}

// ── File-Write Command Detection ──────────────────────────────────────────────
// Only cat heredoc and sed heredoc are the authorised write methods.
// open().write() python style is no longer supported — we detect cat/sed writes.
const FILE_WRITE_CMD_RE = /^\s*(?:cat\s+[>|]+|sed\s+)/i;

function isFileWriteCommand(cmd) {
  return FILE_WRITE_CMD_RE.test(cmd.trim().split('\n')[0]);
}

// ── Long-Running Process Detection ───────────────────────────────────────────
// Commands like `python3 app.py` or `python3 -m uvicorn ...` run indefinitely.
// They must be spawned in the background (no timeout), with startup output
// collected for a short window, then control returned to the agent.
//
// Matches:
//   python3 app.py
//   python app.py
//   python3 -m uvicorn ...
//   python3 -m flask run
//   python3 -m http.server
//   python3 -m gunicorn ...
//   python3 manage.py runserver   (Django)
const LONG_RUNNING_PYTHON_RE = /^\s*python3?\s+(?!-c\s)(?:-m\s+(uvicorn|flask|gunicorn|http\.server|django|manage)|(?!-)\S+\.py\b)/i;

function isLongRunningCommand(cmd) {
  const firstLine = cmd.trim().split('\n')[0];
  return LONG_RUNNING_PYTHON_RE.test(firstLine);
}

// Derive a short stable label from the command (used as bgProcesses key)
function processLabel(cmd) {
  return cmd.trim().split('\n')[0].replace(/\s+/g, ' ').slice(0, 60);
}

// Spawn a long-running process in the background.
// Collects up to STARTUP_COLLECT_MS of stdout/stderr, then resolves.
// The process stays alive; call killBgProcess(label) to stop it.
const STARTUP_COLLECT_MS = 3000; // wait up to 3s for startup output

function spawnBackground(command) {
  return new Promise((resolve) => {
    const label = processLabel(command);

    // Kill any previous process with same label before starting a new one
    if (bgProcesses.has(label)) {
      const prev = bgProcesses.get(label);
      try { prev.proc.kill('SIGTERM'); } catch { /* already dead */ }
      bgProcesses.delete(label);
      log(`  ↳ killed previous bg process: ${label}`, C.yellow);
    }

    const proc = spawn('bash', ['-c', command], {
      cwd: WORKSPACE,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,  // stay in our process group so SIGTERM reaches it
    });

    const startTime = Date.now();
    let startupOutput = '';
    let settled = false;

    function settle(exitCode) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const pid = proc.pid;
      const alive = exitCode === null; // null = still running

      if (alive) {
        bgProcesses.set(label, { pid, proc, command, startTime });
        log(`  ✓ bg process started: ${label} (pid ${pid})`, C.green);
        broadcastSSE('bg_process_started', { label, pid, command, startupOutput });
        resolve({
          ok: true,
          background: true,
          pid,
          label,
          startupOutput,
          message: `Process started in background (pid ${pid}). Send POST /kill-process {"label":"${label}"} to stop it.`,
        });
      } else {
        // Process exited before the collect window — treat as a normal command result
        log(`  ↳ bg candidate exited early (code ${exitCode}): ${label}`, C.yellow);
        resolve({
          ok: exitCode === 0,
          background: false,
          output: startupOutput,
          exitCode,
        });
      }
    }

    proc.stdout.on('data', chunk => { startupOutput += chunk.toString(); });
    proc.stderr.on('data', chunk => { startupOutput += chunk.toString(); });

    proc.on('exit', (code) => {
      bgProcesses.delete(label);
      if (!settled) {
        settle(code ?? 1);
      } else {
        // Process died after we already resolved — broadcast so the UI knows
        broadcastSSE('bg_process_exited', { label, pid: proc.pid, exitCode: code ?? 1 });
        log(`  ↳ bg process exited: ${label} (code ${code})`, C.dim);
      }
    });

    // After STARTUP_COLLECT_MS, if still running, resolve as background
    const timer = setTimeout(() => settle(null), STARTUP_COLLECT_MS);
  });
}

// Kill a tracked background process by label
function killBgProcess(label) {
  const entry = bgProcesses.get(label);
  if (!entry) return { ok: false, error: `No background process with label: ${label}` };
  try {
    entry.proc.kill('SIGTERM');
    bgProcesses.delete(label);
    log(`  ✓ killed bg process: ${label} (pid ${entry.pid})`, C.green);
    broadcastSSE('bg_process_killed', { label, pid: entry.pid });
    return { ok: true, label, pid: entry.pid };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Active Streams ────────────────────────────────────────────────────────────
const activeStreams = new Map();

// ── SSE Clients ───────────────────────────────────────────────────────────────
const sseClients = new Set();

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  route(url.pathname, req, res);
});

function route(pathname, req, res) {
  if (pathname === '/health' && req.method === 'GET') return handleHealth(res);
  if (pathname === '/execute' && req.method === 'POST') return handleExecute(req, res);
  if (pathname === '/stream-chunk' && req.method === 'POST') return handleStreamChunk(req, res);
  if (pathname === '/stream-end' && req.method === 'POST') return handleStreamEnd(req, res);
  if (pathname === '/stream' && req.method === 'GET') return handleSSE(req, res);
  if (pathname === '/files' && req.method === 'GET') return handleListWorkspace(res);
  if (pathname === '/paste' && req.method === 'POST') return handlePaste(req, res);
  if (pathname === '/kill-process' && req.method === 'POST') return handleKillProcess(req, res);
  if (pathname === '/processes' && req.method === 'GET') return handleListProcesses(res);
  sendJSON(res, 404, { error: 'Not found' });
}

// ── /health ────────────────────────────────────────────────────────────────────
function handleHealth(res) {
  const processes = [];
  for (const [label, entry] of bgProcesses) {
    processes.push({ label, pid: entry.pid, uptimeMs: Date.now() - entry.startTime });
  }
  sendJSON(res, 200, {
    ok: true,
    tool: 'vibebridge-v14.1',
    version: VERSION,
    stats,
    workspace: WORKSPACE,
    baseDir: BASE_DIR,
    autoApprove: AUTO_APPROVE,
    backgroundProcesses: processes,
  });
}

// ── /stream-chunk ─────────────────────────────────────────────────────────────
function handleStreamChunk(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }

    const { streamId, chunk: text, accumulatedText, fullText: chunkFullText, type, language, timestamp } = payload;
    if (!streamId || !text) return sendJSON(res, 400, { error: 'Missing streamId or chunk' });

    stats.chunksReceived++;

    let stream = activeStreams.get(streamId);
    if (!stream) {
      stream = { chunks: [], latestFullText: '', startTime: Date.now(), language };
      activeStreams.set(streamId, stream);
    }

    stream.chunks.push({ text, type, language, timestamp });
    if (accumulatedText && accumulatedText.length > (stream.latestFullText || '').length) {
      stream.latestFullText = accumulatedText;
    }
    if (chunkFullText && chunkFullText.length > (stream.latestFullText || '').length) {
      stream.latestFullText = chunkFullText;
    }

    broadcastSSE('stream_chunk', {
      streamId,
      chunk: text,
      type,
      language,
      chunkIndex: stream.chunks.length,
      totalLength: stream.chunks.map(c => c.text).join('').length
    });

    if (type === 'code_start') {
      broadcastSSE('code_block_start', { streamId, language: language || 'plaintext' });
    }

    log(`${C.cyan}chunk${C.reset} ${streamId.slice(0, 12)}... +${text.length} chars`);
    sendJSON(res, 200, { ok: true, chunkIndex: stream.chunks.length });
  });
}

// ── /stream-end ───────────────────────────────────────────────────────────────
async function handleStreamEnd(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }

    const { streamId, fullText, autoApprove: clientAuto } = payload;
    stats.streamsReceived++;

    const stream = activeStreams.get(streamId);
    let reconstructedText;

    const chunkDeltaText = stream && stream.chunks.length > 0
      ? stream.chunks.map(c => c.text).join('')
      : '';
    const snapshotText = stream?.latestFullText || '';

    if (fullText && fullText.length > 0) {
      reconstructedText = fullText;
      log(`${C.green}stream complete${C.reset} ${(streamId || 'unknown').slice(0, 12)}... (fullText: ${fullText.length} chars)`);
    } else if (snapshotText.length > 0) {
      reconstructedText = snapshotText;
      log(`${C.green}stream complete${C.reset} (snapshot: ${snapshotText.length} chars)`);
    } else if (chunkDeltaText.length > 0) {
      reconstructedText = chunkDeltaText;
      log(`${C.yellow}stream complete${C.reset} (delta reconstruction: ${stream.chunks.length} chunks)`);
    } else {
      log(`${C.yellow}stream-end received but no text found${C.reset}`);
      return sendJSON(res, 200, { ok: true, actions: [], fullText: '' });
    }

    if (stream) activeStreams.delete(streamId);

    const { actions, partialBlocks } = parseActionsWithPartial(reconstructedText);

    if (partialBlocks > 0) {
      stats.partialBlocks += partialBlocks;
      log(`${C.yellow}  ⚠ ${partialBlocks} partial code blocks${C.reset}`);
    }

    if (actions.length > 0) {
      log(`${C.green}  Found ${actions.length} actions${C.reset}`);
      actions.forEach((action, i) => {
        const detail = action.params?.path || action.params?.command?.slice(0, 40) || '';
        log(`    ${i + 1}. ${action.type}: ${detail}`);
      });
    }

    broadcastSSE('stream_complete', {
      streamId: streamId || 'unknown',
      actionCount: actions.length,
      partialBlocks,
      preview: reconstructedText.slice(0, 100)
    });

    const results = [];
    const shouldAuto = AUTO_APPROVE || clientAuto || global._sessionAutoApprove;

    for (const action of actions) {
      stats.dispatched++;

      if (action.type === 'execute_command') {
        const cmd = action.params?.command || '';

        // ── Pip double-execution guardrail ───────────────────────────────────
        if (isDuplicatePip(cmd)) {
          results.push({ action, result: { ok: true, output: '[pip dedup: skipped duplicate install]', exitCode: 0, skipped: true } });
          continue;
        }

        // ── Python double-execution guardrail ────────────────────────────────
        if (isDuplicatePython(cmd)) {
          results.push({ action, result: { ok: true, output: '[python dedup: skipped duplicate command]', exitCode: 0, skipped: true } });
          continue;
        }

        if (isDuplicateCommand(cmd)) {
          stats.skippedDuplicates++;
          log(`  ⟳ skipped duplicate: ${cmd.slice(0, 60)}`, C.yellow);
          results.push({ action, result: { ok: true, output: '', exitCode: 0, skipped: true } });
          continue;
        }
      }

      const isFileWrite = action.type === 'execute_command' &&
        isFileWriteCommand(action.params?.command || '');

      if (!shouldAuto && !isFileWrite) {
        const allowed = await promptConfirm(action);
        if (!allowed) {
          stats.failed++;
          log(`  ✗ cancelled: ${action.type}`);
          results.push({ action, error: 'User cancelled' });
          continue;
        }
      }

      if (isFileWrite && !shouldAuto) {
        log(`  ↳ auto-approved file-write command`, C.dim);
      }

      try {
        const result = await dispatch(action);
        stats.succeeded++;
        results.push({ action, result });

        if (action.type === 'execute_command') {
          const cmd = action.params?.command || '';
          const exitCode = result.exitCode ?? 0;
          // Mark dedup registries on success so retries are allowed on failure
          if (exitCode === 0) {
            markPipSucceeded(cmd);
            markPythonSucceeded(cmd);
            markCommandSucceeded(cmd);
          }
          broadcastSSE('command_result', {
            command: cmd,
            output: result.output || '',
            exitCode,
          });
          log(`  ✓ ${action.type}: exit ${exitCode}`);
        } else if (action.type === 'write_file') {
          broadcastSSE('action_result', {
            type: action.type,
            params: action.params,
            result
          });
          log(`  ✓ ${action.type}: ${action.params?.path}`);
        }
      } catch (err) {
        stats.failed++;
        results.push({ action, error: err.message });
        log(`  ✗ ${action.type}: ${err.message}`, C.red);
        if (isFileWrite) {
          broadcastSSE('command_result', {
            command: action.params?.command,
            output: err.message,
            exitCode: 1
          });
        }
      }
    }

    sendJSON(res, 200, {
      ok: true,
      actions,
      results,
      partialBlocks,
      fullText: reconstructedText
    });
  });
}

// ── /stream (SSE) ─────────────────────────────────────────────────────────────
function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  res.write(`event: connected\ndata: ${JSON.stringify({ workspace: WORKSPACE, version: VERSION })}\n\n`);
  sseClients.add(res);

  log(`SSE client connected (${sseClients.size} total)`, C.cyan);

  const heartbeat = setInterval(() => {
    if (sseClients.has(res)) {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        sseClients.delete(res);
        clearInterval(heartbeat);
      }
    } else {
      clearInterval(heartbeat);
    }
  }, 15000);

  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(heartbeat);
    log(`SSE client disconnected (${sseClients.size} remaining)`, C.dim);
  });
}

// ── /execute ──────────────────────────────────────────────────────────────────
async function handleExecute(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }

    const { action, source, autoApprove: clientAuto } = payload;
    if (!action?.type) return sendJSON(res, 400, { error: 'Missing action.type' });

    stats.dispatched++;
    log(`← ${source || '?'} | ${C.cyan}${action.type}${C.reset}`);

    const shouldAuto = AUTO_APPROVE || clientAuto || global._sessionAutoApprove;

    if (action.type === 'execute_command') {
      const cmd = action.params?.command || '';

      // ── Pip double-execution guardrail ─────────────────────────────────────
      if (isDuplicatePip(cmd)) {
        return sendJSON(res, 200, { ok: true, output: '[pip dedup: skipped duplicate install]', exitCode: 0, skipped: true });
      }

      // ── Python double-execution guardrail ───────────────────────────────────
      if (isDuplicatePython(cmd)) {
        return sendJSON(res, 200, { ok: true, output: '[python dedup: skipped duplicate command]', exitCode: 0, skipped: true });
      }

      if (isDuplicateCommand(cmd)) {
        stats.skippedDuplicates++;
        log(`  ⟳ skipped duplicate: ${cmd.slice(0, 60)}`, C.yellow);
        return sendJSON(res, 200, { ok: true, output: '', exitCode: 0, skipped: true });
      }
    }

    const isFileWrite = action.type === 'execute_command' &&
      isFileWriteCommand(action.params?.command || '');

    if (!shouldAuto && !isFileWrite) {
      const allowed = await promptConfirm(action);
      if (!allowed) {
        stats.failed++;
        log('✗ cancelled by user', C.yellow);
        return sendJSON(res, 200, { error: 'User cancelled' });
      }
    }

    if (isFileWrite && !shouldAuto) {
      log(`  ↳ auto-approved file-write command`, C.dim);
    }

    try {
      const result = await dispatch(action);
      stats.succeeded++;
      // Mark dedup registries on success so retries are allowed on failure
      if (action.type === 'execute_command' && (result.exitCode ?? 0) === 0) {
        const cmd = action.params?.command || '';
        markPipSucceeded(cmd);
        markPythonSucceeded(cmd);
        markCommandSucceeded(cmd);
      }
      broadcastSSE('action_result', { type: action.type, params: action.params, result });
      log(`✓ ${action.type} OK`, C.green);
      sendJSON(res, 200, result);
    } catch (err) {
      stats.failed++;
      log(`✗ ${action.type} FAILED: ${err.message}`, C.red);
      sendJSON(res, 200, { error: err.message });
    }
  });
}

// ── Action Dispatcher ─────────────────────────────────────────────────────────
async function dispatch(action) {
  switch (action.type) {
    case 'write_file': return writeFileLive(action.params);
    case 'read_file': return readFile(action.params);
    case 'execute_command': return executeCommand(action.params);
    case 'apply_diff': return applyDiff(action.params);
    case 'list_files': return listFiles(action.params);
    case 'search_files': return searchFiles(action.params);
    case 'attempt_completion': return showCompletion(action.params);
    default: throw new Error(`Unsupported action: ${action.type}`);
  }
}

// ── Path Resolution ────────────────────────────────────────────────────────────
function resolvePath(filePath) {
  if (!filePath) throw new Error('Missing path');

  // No /workspace/ prefix stripping needed — root IS workspace
  const topLevel = filePath.replace(/^\//, '').split('/')[0].split('\\')[0];

  if (SERVER_IGNORES.has(topLevel)) {
    throw new Error(`Path is protected: ${filePath}`);
  }

  const abs = path.resolve(WORKSPACE, filePath);
  if (!abs.startsWith(WORKSPACE)) throw new Error(`Path escapes workspace: ${filePath}`);
  return abs;
}

// ── Write File ────────────────────────────────────────────────────────────────
async function writeFileLive({ path: filePath, content }) {
  const abs = resolvePath(filePath);
  const rel = path.relative(WORKSPACE, abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  broadcastSSE('file_open', { path: rel, fullPath: abs });
  log(`  → ${rel}`, C.magenta);

  const text = sanitizeContent(content ?? '');
  fs.writeFileSync(abs, text);

  const bytes = Buffer.byteLength(text);
  broadcastSSE('file_done', { path: rel, bytes });
  log(`  ✓ ${rel} (${bytes} bytes)`, C.green);

  return { ok: true, path: filePath, bytes };
}

// ── Read File ─────────────────────────────────────────────────────────────────
function readFile({ path: filePath }) {
  const abs = resolvePath(filePath);

  if (filePath === '.' || !filePath.includes('.') || fs.statSync(abs).isDirectory()) {
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    const files = entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }));
    return { ok: true, path: filePath, files };
  }

  if (!fs.existsSync(abs)) throw new Error(`File not found: ${filePath}`);
  const content = fs.readFileSync(abs, 'utf8');
  return { ok: true, content };
}

// ── Heredoc / Multi-line Command Normaliser ───────────────────────────────────
const HEREDOC_RE = /<<\s*['"']?\w+['"']?/;

function normaliseCommand(raw) {
  const expanded = raw.replace(/\\n/g, '\n');
  const hasRealNewlines = expanded.includes('\n');
  const hasHeredoc      = HEREDOC_RE.test(expanded);
  return { expanded, needsBashStdin: hasRealNewlines || hasHeredoc };
}

// ── Execute Command ───────────────────────────────────────────────────────────
function executeCommand({ command }) {
  if (!command) throw new Error('Missing command');
  log(`  $ ${command.slice(0, 120)}`, C.dim);

  const isWin = process.platform === 'win32';
  const { expanded, needsBashStdin } = normaliseCommand(command);

  // ── Long-running server commands: spawn in background, no timeout ─────────
  if (!isWin && isLongRunningCommand(expanded)) {
    log(`  [long-running → background spawn]`, C.dim);
    return spawnBackground(expanded); // returns a Promise
  }

  // ── All other commands: spawnSync with NO timeout ─────────────────────────
  // spawnSync blocks until the process exits naturally — no matter how long.
  // This correctly handles pip installs, slow builds, network-dependent ops, etc.
  log(`  [spawnSync — no timeout]`, C.dim);

  let result;
  if (!isWin && needsBashStdin) {
    log(`  [heredoc/multi-line → bash stdin]`, C.dim);
    result = spawnSync('bash', ['-s'], {
      cwd: WORKSPACE,
      encoding: 'utf8',
      input: expanded,
      maxBuffer: 100 * 1024 * 1024, // 100 MB output buffer
    });
  } else if (isWin) {
    result = spawnSync('cmd', ['/c', command], {
      cwd: WORKSPACE,
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024,
    });
  } else {
    result = spawnSync('bash', ['-c', expanded], {
      cwd: WORKSPACE,
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024,
    });
  }

  const output   = ((result.stdout || '') + (result.stderr || '')).trim();
  const exitCode = result.status ?? (result.error ? 1 : 0);

  if (result.error) {
    // e.g. ENOENT if command not found
    log(`  ✗ spawn error: ${result.error.message}`, C.red);
  }

  if (output) {
    output.split('\n').forEach(l => log(`  │ ${l}`, C.dim));
  }

  broadcastSSE('command_result', { command, output, exitCode });

  return { ok: exitCode === 0, output, exitCode };
}

// ── Apply Diff ────────────────────────────────────────────────────────────────
function applyDiff({ path: filePath, diff }) {
  const abs = resolvePath(filePath);
  const original = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const newContent = patchDiff(diff, original);
  return writeFileLive({ path: filePath, content: newContent });
}

// ── List Files ────────────────────────────────────────────────────────────────
function listFiles({ path: dirPath = '.' }) {
  const abs = resolvePath(dirPath);
  if (!fs.existsSync(abs)) throw new Error(`Directory not found: ${dirPath}`);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const files = entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }));
  return { ok: true, path: dirPath, files };
}

// ── Search Files ─────────────────────────────────────────────────────────────
function searchFiles({ pattern, path: dirPath = '.', file_pattern: fp }) {
  if (!pattern) throw new Error('Missing pattern');
  const abs = resolvePath(dirPath);
  const include = fp || '*';
  let output = '';
  try {
    output = execSync(`grep -rn --include="${include}" "${pattern.replace(/"/g, '\\"')}" .`, {
      cwd: abs, encoding: 'utf8', timeout: 10_000,
    });
  } catch { /* no matches */ }
  const matches = output.trim().split('\n').filter(Boolean);
  return { ok: true, pattern, matches };
}

// ── Completion ───────────────────────────────────────────────────────────────
function showCompletion({ result }) {
  const msg = (result || '').slice(0, 300);
  log(`\n${C.bold}${C.green}✅ ${msg}${C.reset}\n`);
  broadcastSSE('completion', { result: msg });
  return { ok: true };
}

// ── /kill-process ─────────────────────────────────────────────────────────────
async function handleKillProcess(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }

    // Accept either { label } or { pid } — label is preferred
    const { label, pid } = payload;

    if (label) {
      return sendJSON(res, 200, killBgProcess(label));
    }

    if (pid) {
      // Find by pid
      for (const [lbl, entry] of bgProcesses) {
        if (entry.pid === pid) return sendJSON(res, 200, killBgProcess(lbl));
      }
      return sendJSON(res, 404, { ok: false, error: `No background process with pid: ${pid}` });
    }

    return sendJSON(res, 400, { error: 'Provide label or pid' });
  });
}

// ── /processes ────────────────────────────────────────────────────────────────
function handleListProcesses(res) {
  const list = [];
  for (const [label, entry] of bgProcesses) {
    list.push({
      label,
      pid: entry.pid,
      command: entry.command,
      uptimeMs: Date.now() - entry.startTime,
    });
  }
  sendJSON(res, 200, { ok: true, processes: list });
}

// ── /files ────────────────────────────────────────────────────────────────────
function handleListWorkspace(res) {
  const list = walkDir(WORKSPACE, WORKSPACE);
  sendJSON(res, 200, { ok: true, workspace: WORKSPACE, files: list });
}

// ── /paste ────────────────────────────────────────────────────────────────────
async function handlePaste(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }

    const { filePath, content, source, autoApprove: clientAuto } = payload;
    if (!filePath) return sendJSON(res, 400, { error: 'Missing filePath' });
    if (content === undefined || content === null) return sendJSON(res, 400, { error: 'Missing content' });

    stats.dispatched++;
    log(`← ${source || 'clipboard'} | paste → ${filePath}`);

    const shouldAuto = AUTO_APPROVE || clientAuto || global._sessionAutoApprove;
    if (!shouldAuto) {
      const allowed = await promptConfirm({ type: 'paste_file', params: { path: filePath } });
      if (!allowed) {
        stats.failed++;
        return sendJSON(res, 200, { error: 'User cancelled' });
      }
    }

    try {
      const result = await writeFileLive({ path: filePath, content });
      stats.succeeded++;
      log(`✓ paste OK → ${filePath}`, C.green);
      sendJSON(res, 200, result);
    } catch (err) {
      stats.failed++;
      log(`✗ paste FAILED: ${err.message}`, C.red);
      sendJSON(res, 200, { error: err.message });
    }
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function sanitizeContent(content) {
  if (!content) return content;
  return content.replace(/\r\n/g, '\n');
}

function patchDiff(diff, original) {
  const lines = diff.split('\n'), result = [], origLines = original.split('\n');
  let idx = 0;
  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) result.push(line.slice(1));
    else if (line.startsWith('-')) idx++;
    else result.push(origLines[idx++] ?? line.slice(1));
  }
  return result.join('\n');
}

function walkDir(dir, root) {
  const entries = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') && e.name !== '.gitignore') continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      if (SERVER_IGNORES.has(e.name)) continue;
      if (e.isDirectory()) {
        entries.push({ name: e.name, type: 'directory', path: rel, children: walkDir(abs, root) });
      } else {
        entries.push({ name: e.name, type: 'file', path: rel, size: fs.statSync(abs).size });
      }
    }
  } catch { /* ignore */ }
  return entries;
}

// ── Action Parser ─────────────────────────────────────────────────────────────
// WRITE METHODS: cat heredoc and sed heredoc ONLY.
// The // FILENAME: directive is removed — the AI must use cat/sed.

const CMD_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'ps1', 'powershell', 'cmd', 'bat']);

function dedupeActions(actions) {
  const seen = new Set();
  return actions.filter(a => {
    const key = a.type + ':' + (a.params?.path || a.params?.command || '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseActionsWithPartial(text) {
  const actions = [];
  let partialBlocks = 0;

  // ── GUARDRAIL 1: Strip ALL think/reasoning blocks ────────────────────────────
  // Handles: <think>, <thinking>, [THINK], partial/unclosed blocks at end of stream.
  // An unclosed <think> that starts but never closes = strip everything after the tag.
  let stripped = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')        // closed <think>
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')  // closed <thinking>
    .replace(/<think>[\s\S]*/gi, '')                  // unclosed <think> — kill to end
    .replace(/<thinking>[\s\S]*/gi, '')               // unclosed <thinking> — kill to end
    .replace(/\[THINK\][\s\S]*?\[\/THINK\]/gi, '')    // [THINK] variant
    .replace(/\[THINK\][\s\S]*/gi, '')                // unclosed [THINK]
    .trim();

  // ── GUARDRAIL 2: Conversational reply detection ───────────────────────────────
  // If the response looks like a conversational reply (prose, explanation, apology,
  // question, greeting) rather than an agentic command sequence — abort entirely.
  // We check the text OUTSIDE code fences only, so a valid response with prose
  // preamble before the first bash block still passes if the prose is short.

  const prose = stripped.replace(/```[\s\S]*?```/g, '').trim();  // text outside fences
  const proseLines = prose.split('\n').map(l => l.trim()).filter(Boolean);
  const totalLines = stripped.split('\n').length;
  const fenceCount = (stripped.match(/```/g) || []).length / 2;

  // Conversational signal phrases — these appear in explanatory/chatty responses
  const CONVERSATIONAL_PATTERNS = [
    /^(sure|okay|ok|got it|of course|absolutely|certainly|happy to|great|hello|hi there|no problem|understood|i understand|i see|i'll|i will|i can|let me|let's|here('s| is)|i've|i have|i'm|i am|to do this|in order to|first,|firstly|next,|then,|finally,|step \d)/i,
    /^(sorry|apolog|unfortunately|i (can't|cannot|don't|do not)|that's not|this (isn't|is not)|please note|note that|be aware|keep in mind)/i,
    /\?$/,  // ends with question mark (asking clarification)
  ];

  const SAFE_PROSE_PATTERNS = [
    /^#\s+\[AGENT:/i,          // agent role comment that leaked outside fence
    /^\/\/\s*COMMAND:/i,       // COMMAND directive
    /^```/,                    // starts a fence
  ];

  // Count how many prose lines match conversational patterns vs safe patterns
  let conversationalHits = 0;
  let safeHits = 0;

  for (const line of proseLines.slice(0, 10)) {  // only check first 10 prose lines
    if (SAFE_PROSE_PATTERNS.some(p => p.test(line))) { safeHits++; continue; }
    if (CONVERSATIONAL_PATTERNS.some(p => p.test(line))) conversationalHits++;
  }

  // If we have conversational prose AND no fences at all — this is a chat reply, skip it
  if (conversationalHits > 0 && fenceCount === 0) {
    log(`  ⛔ conversational reply detected (${conversationalHits} signal(s), no code fences) — skipping execution`, C.yellow);
    return { actions: [], partialBlocks: 0, blocked: true, reason: 'conversational' };
  }

  // If prose is very long relative to code (>80% prose by line count) and has conversational signals
  const proseRatio = totalLines > 0 ? proseLines.length / totalLines : 0;
  if (conversationalHits > 0 && proseRatio > 0.8 && fenceCount < 2) {
    log(`  ⛔ response is mostly prose (${Math.round(proseRatio * 100)}% prose, ${conversationalHits} conversational signal(s)) — skipping execution`, C.yellow);
    return { actions: [], partialBlocks: 0, blocked: true, reason: 'prose_dominant' };
  }

  const cleanText = stripped;

  // ── GUARDRAIL 3: Validate bash block content ──────────────────────────────────
  // A bash block that is entirely prose (explanation disguised as code) should not run.
  // We check: does the block contain at least one line that looks like a real command?
  const REAL_COMMAND_RE = /^(cat\s|sed\s|echo\s|printf\s|mkdir|rm\s|cp\s|mv\s|cd\s|ls|touch\s|chmod\s|pip\s|pip3\s|python\s|python3\s|node\s|npm\s|yarn\s|git\s|curl\s|wget\s|apt|sudo\s|export\s|source\s|bash\s|sh\s|find\s|grep\s|awk\s|tar\s|zip\s|unzip\s|\.\/)|\$\s+\S/im;

  function isRealCommandBlock(blockContent) {
    // Reject if first non-empty line looks like prose (starts with capital letter word, no special chars)
    const lines = blockContent.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return false;
    const firstLine = lines[0];
    // If block starts with a sentence (capital, no shell chars) AND has no real commands → prose block
    const looksLikeProse = /^[A-Z][a-z]/.test(firstLine) && !/[|>&$#]/.test(firstLine);
    const hasRealCommand = REAL_COMMAND_RE.test(blockContent);
    if (looksLikeProse && !hasRealCommand) return false;
    return hasRealCommand || CMD_LANGS.has('bash'); // bash-tagged blocks are trusted if they have any content
  }

  // ── Pattern 1: Complete fenced code blocks ────────────────────────────────────
  const completeFenceRe = /```(\w*)\s*\n([\s\S]*?)```/g;

  for (const match of cleanText.matchAll(completeFenceRe)) {
    const lang = (match[1] || '').toLowerCase().trim();
    const blockContent = match[2];

    if (CMD_LANGS.has(lang)) {
      const cmd = blockContent.trim();
      // GUARDRAIL 3: validate the block isn't just explanatory prose
      if (cmd && isRealCommandBlock(cmd)) {
        actions.push({ type: 'execute_command', params: { command: cmd } });
      } else if (cmd) {
        log(`  ⛔ bash block rejected (no real commands detected): ${cmd.slice(0, 60).replace(/\n/g, ' ')}`, C.yellow);
      }
      continue;
    }

    // Bare shell command detection (no lang or txt)
    if (lang === '' || lang === 'txt' || lang === 'text') {
      const firstLine = blockContent.split('\n')[0].trim();
      const SHELL_CMD_RE = /^(cat\s|sed\s|echo\s|printf\s|mkdir\s|rm\s|cp\s|mv\s|cd\s|ls\s|touch\s|chmod\s|chown\s|pip\s|pip3\s|python\s|python3\s|node\s|npm\s|yarn\s|git\s|curl\s|wget\s|apt\s|apt-get\s|sudo\s|export\s|source\s|bash\s|sh\s|find\s|grep\s|awk\s|tar\s|zip\s|unzip\s|\.\/)/i;
      if (SHELL_CMD_RE.test(firstLine)) {
        const cmd = blockContent.trim();
        if (cmd) actions.push({ type: 'execute_command', params: { command: cmd } });
        continue;
      }
    }

    // COMMAND: directive (single line)
    const firstLine = blockContent.split('\n')[0].trim();
    const cmdDirective = firstLine.match(/^\/\/\s*COMMAND:\s*(.+)$/i);
    if (cmdDirective) {
      const directiveLine = cmdDirective[1].trim();
      const bodyLines = blockContent.split('\n').slice(1);
      const body = bodyLines.join('\n');
      const cmd = body.trim() ? directiveLine + '\n' + body : directiveLine;
      if (cmd) actions.push({ type: 'execute_command', params: { command: cmd } });
      continue;
    }
  }

  // ── Pattern 2: Standalone // COMMAND: lines ────────────────────────────────
  const noCodeBlocks = cleanText.replace(/```[\s\S]*?```/g, '');
  const cmdLineRe = /^[ \t]*\/\/\s*COMMAND:\s*(.+)$/gim;
  for (const match of noCodeBlocks.matchAll(cmdLineRe)) {
    const cmd = match[1].trim();
    if (cmd) actions.push({ type: 'execute_command', params: { command: cmd } });
  }

  // ── Pattern 2.5: Bare heredoc commands outside fences ──────────────────────
  const HEREDOC_OPEN_RE = /^(cat\s+[>|]+\s*\S+\s*<<\s*['"']?(\w+)['"']?)\s*$/gm;
  for (const match of noCodeBlocks.matchAll(HEREDOC_OPEN_RE)) {
    const delimiter = match[2];
    const startIdx = match.index;
    const afterOpen = noCodeBlocks.slice(startIdx);
    const closeRe = new RegExp(`^${delimiter}\\s*$`, 'm');
    const closeMatch = closeRe.exec(afterOpen);
    if (closeMatch) {
      const fullCmd = afterOpen.slice(0, closeMatch.index + closeMatch[0].length).trim();
      if (fullCmd) actions.push({ type: 'execute_command', params: { command: fullCmd } });
    }
  }

  // ── Pattern 3: Partial blocks (streaming cut-off fallback) ────────────────
  if (!actions.length) {
    const partialRe = /```(\w*)\s*\n([\s\S]+)$/gm;
    for (const match of cleanText.matchAll(partialRe)) {
      const lang = (match[1] || '').toLowerCase().trim();
      const blockContent = match[2];

      if (CMD_LANGS.has(lang)) {
        const cmd = blockContent.trim();
        if (cmd && cmd.length > 2 && isRealCommandBlock(cmd)) {
          actions.push({ type: 'execute_command', params: { command: cmd } });
          partialBlocks++;
        }
      }
    }
  }

  return { actions: dedupeActions(actions), partialBlocks };
}
function promptConfirm(action) {
  return new Promise(resolve => {
    const label = `${action.type}: ${JSON.stringify(action.params || {}).slice(0, 80)}`;
    process.stdout.write(`\n${C.yellow}⚡ ${label}${C.reset}\nAllow? [y]es / [n]o / [a]lways: `);
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.once('line', line => {
      rl.close();
      const ans = line.trim().toLowerCase();
      if (ans === 'a' || ans === 'always') { global._sessionAutoApprove = true; resolve(true); }
      else resolve(ans === 'y' || ans === 'yes');
    });
    rl.once('close', () => resolve(false));
  });
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// ── Boot ─────────────────────────────────────────────────────────────────────
ensureGitignore();

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `\n${C.bold}${C.cyan}⚡ VibeBridge v14.1${C.reset} ${VERSION}\n` +
    `${C.green}✓ Server running${C.reset}  →  http://localhost:${PORT}\n` +
    `${C.dim}  Root dir  : ${WORKSPACE}${C.reset}\n` +
    `${C.dim}  Auto-approve: ${AUTO_APPROVE ? 'yes' : 'no'}${C.reset}\n` +
    `${C.dim}  SSE heartbeat: 15s${C.reset}\n` +
    `${C.dim}  Write methods: cat heredoc | sed heredoc${C.reset}\n` +
    `${C.dim}  Pip dedup window: 120s${C.reset}\n` +
    `${C.dim}  Python dedup window: 120s | All commands: no timeout${C.reset}\n` +
    `${C.dim}  Dedup blocks only after SUCCESS — failed runs always retryable${C.reset}\n` +
    `${C.dim}  Long-running cmds (app.py etc): background spawn, no timeout${C.reset}\n` +
    `${C.dim}  Stop a bg process: POST /kill-process {"label":"<cmd>"}${C.reset}\n\n` +
    `Actions executed automatically when stream ends.\n` +
    `${C.dim}Press Ctrl+C to stop.${C.reset}\n`
  );
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE')
    console.error(`${C.red}✗ Port ${PORT} in use${C.reset}`);
  else
    console.error(`${C.red}✗ ${err.message}${C.reset}`);
  process.exit(1);
});

process.on('SIGINT', () => { console.log(`\n${C.dim}VibeBridge stopped.${C.reset}`); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
