// ─── VibeBridge Stream Capture v13.1 ──────────────────────────────────────────
// Real-time streaming response capture for AI chat interfaces
//
// FIXES v13.1 (bug: // FILENAME: blocks write empty files):
// Mirrored server-side parser fixes into parseActions() (used for local logging).
// - `while (content.startsWith('\n'))` instead of single `if` check.
// - `if (filePath && content.trim())` instead of `if (filePath && content)`.
//
// FIXES v12.1 (bug: files always empty / FILENAME blocks not detected):
// ROOT CAUSE: AI chat UIs render markdown — the DOM never contains ``` fences
// or // FILENAME: directives. accumulatedText was built from rendered DOM text,
// so the server's regex found no code blocks and wrote nothing.
//
// FIX 1: fetch() interception — intercepts AI streaming API responses and
//   accumulates RAW markdown (with fences) into rawMarkdownBuffer BEFORE the
//   UI renders it. fireStreamEnd() sends rawMarkdownBuffer as fullText.
// FIX 2: parseActions() rewritten to match server.js logic exactly — now
//   correctly enforces // FILENAME: directive (old regex captured any comment).
// FIX 3 (server.js): sanitizeContent() no longer calls .trim() — trimming
//   strips intentional leading/trailing whitespace from file contents.
//
// How it works:
// 1. MutationObserver watches for AI response elements
// 2. Intercepts streaming text updates character-by-character
// 3. Sends chunks to background service via chrome.runtime
// 4. Background streams to local server via HTTP
// 5. Server parses actions and executes commands
// 6. Results are injected back into the AI chat

(function () {
  'use strict';

  const SOURCE = 'stream-capture';

  // ── Stream State Variables ───────────────────────────────────────────────────
  let currentStreamId = null;
  let accumulatedText = '';
  let lastSeenText = '';          // CRITICAL: Cleared on stream end
  let isStreaming = false;
  let streamStartTime = null;
  let tokenCount = 0;
  let streamEndFired = false;     // CRITICAL: Hard guard against double-firing

  // ── Timers ───────────────────────────────────────────────────────────────────
  let debounceTimer = null;
  let stabilityCheckTimer = null;
  let stabilityRound = 0;
  let lastStableText = '';        // Text at start of stability check

  // ── Platform Detection ───────────────────────────────────────────────────────
  function detectPlatform() {
    const hostname = window.location.hostname;

    if (hostname.includes('chatgpt.com') || hostname.includes('openai.com')) return 'chatgpt';
    if (hostname.includes('claude.ai') || hostname.includes('anthropic.com')) return 'claude';
    if (hostname.includes('deepseek.com')) return 'deepseek';
    if (hostname.includes('gemini') || hostname.includes('aistudio.google')) return 'gemini';
    if (hostname.includes('qwen.ai') || hostname.includes('tongyi') || hostname.includes('aliyun')) return 'qwen';
    if (hostname.includes('moonshot.cn')) return 'moonshot';
    if (hostname.includes('groq.com')) return 'groq';
    if (hostname.includes('perplexity.ai')) return 'perplexity';

    return 'unknown';
  }

  const PLATFORM = detectPlatform();

  // ── Platform-Specific Selectors ──────────────────────────────────────────────
  const PLATFORM_CONFIG = {
    claude: {
      isGenerating: () => !!document.querySelector('.inline-loading-indicator, [class*="generating"], [class*="typing"]'),
      messageContainer: '[data-testid="conversation-turn-annotated"], .conversation-turn-annotated, [class*="message"]',
      inputField: 'textarea[data-testid="chat-input"], textarea[name="prompt"]'
    },
    chatgpt: {
      isGenerating: () => !!document.querySelector('[data-testid="turn-loader"], .result-streaming, [class*="generating"]'),
      messageContainer: '[data-message-author-role="assistant"], [class*="message"]',
      inputField: 'textarea[data-testid="chat-input"]'
    },
    deepseek: {
      isGenerating: () => !!document.querySelector('.generating, [class*="streaming"], .typing'),
      messageContainer: '.markdown-body, [class*="message"]',
      inputField: 'textarea'
    },
    gemini: {
      isGenerating: () => !!document.querySelector('.gemini-thinking, [aria-busy="true"], [class*="generating"]'),
      messageContainer: '[class*="message"], [class*="response"], .gemini-response',
      inputField: 'textarea, [contenteditable="true"]'
    },
    qwen: {
      isGenerating: () => !!document.querySelector('.generating, [class*="streaming"], .thinking'),
      messageContainer: '.markdown-body, [class*="message"]',
      inputField: 'textarea'
    },
    moonshot: {
      isGenerating: () => !!document.querySelector('.generating, [class*="streaming"]'),
      messageContainer: '.markdown-body, [class*="message"]',
      inputField: 'textarea'
    },
    groq: {
      isGenerating: () => !!document.querySelector('.generating, [class*="streaming"]'),
      messageContainer: '[class*="message"]',
      inputField: 'textarea'
    },
    perplexity: {
      isGenerating: () => !!document.querySelector('.generating, [class*="streaming"]'),
      messageContainer: '[class*="answer"], [class*="message"]',
      inputField: 'textarea'
    },
    unknown: {
      isGenerating: () => !!document.querySelector('.generating, [class*="streaming"], [aria-busy="true"]'),
      messageContainer: '[role="assistant"], [class*="message"], article, main',
      inputField: 'textarea, [contenteditable="true"]'
    }
  };

  const CONFIG = PLATFORM_CONFIG[PLATFORM] || PLATFORM_CONFIG.unknown;

  // ── Stream ID generator ──────────────────────────────────────────────────────
  function generateStreamId() {
    return `stream_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // ── Input field detection ────────────────────────────────────────────────────
  function getInputField() {
    return (
      document.querySelector(CONFIG.inputField) ||
      document.querySelector('textarea#chat-input') ||
      document.querySelector('textarea') ||
      document.querySelector('[contenteditable="true"]')
    );
  }

  // ── Send button detection ─────────────────────────────────────────────────────
  function getSendButton() {
    return (
      document.querySelector('button[type="submit"]') ||
      document.querySelector('button[aria-label*="send" i]') ||
      document.querySelector('.send-button') ||
      document.querySelector('[data-testid="send-button"]')
    );
  }

  function clickSend() {
    let tries = 0;
    const trySend = () => {
      const btn = getSendButton();
      if (btn && !btn.disabled) { btn.click(); return; }
      if (++tries < 5) setTimeout(trySend, 150);
    };
    trySend();
  }

  // ── Text injection ────────────────────────────────────────────────────────────
  function injectText(text, autoSend = false) {
    const input = getInputField();
    if (!input) {
      console.log('[VibeBridge] No input field found');
      return;
    }

    const nativeSetter = Object.getOwnPropertyDescriptor(
      input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
      'value'
    );

    if (nativeSetter && input.tagName === 'TEXTAREA') {
      nativeSetter.set.call(input, text);
    } else if (input.contentEditable === 'true') {
      input.focus();
      document.execCommand('selectAll');
      document.execCommand('insertText', false, text);
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    if (autoSend) setTimeout(clickSend, 200);
  }

  // ── Raw markdown capture via fetch interception ─────────────────────────────
  // Claude.ai (and most AI chat UIs) render markdown server-side or via JS —
  // the DOM never contains raw fence blocks or // FILENAME: directives.
  // We intercept fetch/XHR to grab the raw streamed markdown BEFORE rendering.
  let rawMarkdownBuffer = '';       // accumulates raw SSE/JSON response text
  let rawMarkdownStreamId = null;

  (function interceptFetch() {
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const response = await origFetch.apply(this, args);
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

      // Only intercept AI completion/chat endpoints
      const isAIEndpoint = /\/completion|\/chat|\/message|\/conversation|\/generate|\/stream/i.test(url);
      if (!isAIEndpoint) return response;

      // Clone so we can read the body without consuming it
      const clone = response.clone();
      (async () => {
        try {
          const reader = clone.body?.getReader();
          if (!reader) return;
          const decoder = new TextDecoder();
          let buf = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            buf += chunk;

            // Extract text content from SSE data lines or JSON chunks
            // Handles: data: {"delta":{"text":"..."}} (Anthropic)
            //          data: {"choices":[{"delta":{"content":"..."}}]} (OpenAI)
            //          data: {"content":"..."} (generic)
            const lines = buf.split('\n');
            buf = lines.pop(); // keep incomplete line

            for (const line of lines) {
              if (!line.startsWith('data:')) continue;
              const raw = line.slice(5).trim();
              if (raw === '[DONE]') continue;
              try {
                const obj = JSON.parse(raw);
                // Anthropic style
                const anthText = obj?.delta?.text || obj?.completion || '';
                // OpenAI style
                const oaiText = obj?.choices?.[0]?.delta?.content || obj?.choices?.[0]?.text || '';
                // Generic
                const genText = obj?.content || obj?.text || obj?.message?.content || '';
                const text = anthText || oaiText || genText;
                if (text) {
                  rawMarkdownBuffer += text;
                }
              } catch { /* not JSON, skip */ }
            }
          }
        } catch { /* ignore interception errors */ }
      })();

      return response;
    };
  })();

  // ── Raw DOM text extraction (fallback when fetch interception misses content) ─
  function extractRawText(el) {
    if (!el) return '';

    const tag = el.tagName && el.tagName.toLowerCase();

    // Skip DeepSeek / QwQ thinking blocks entirely — they have class "think" or "ds-think"
    if (tag && el.classList) {
      for (const cls of el.classList) {
        if (/think|reasoning|chain.of.thought/i.test(cls)) return '';
      }
    }
    // Also skip elements with data attributes marking them as thinking
    if (el.dataset && (el.dataset.think || el.dataset.thinking)) return '';

    // Code/pre blocks: return raw textContent (rendered code, not fenced markdown)
    if (tag === 'pre' || tag === 'code') {
      return el.textContent || '';
    }

    let result = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const ct = node.tagName.toLowerCase();
        // Skip thinking nodes at any depth
        if (node.classList) {
          let isThink = false;
          for (const cls of node.classList) {
            if (/think|reasoning|chain.of.thought/i.test(cls)) { isThink = true; break; }
          }
          if (isThink) continue;
        }
        if (ct === 'pre' || ct === 'code') {
          result += node.textContent;
        } else if (ct === 'br') {
          result += '\n';
        } else if (ct === 'p' || ct === 'div' || ct === 'li') {
          const inner = extractRawText(node);
          result += inner;
          if (inner && !inner.endsWith('\n')) result += '\n';
        } else {
          result += extractRawText(node);
        }
      }
    }
    return result;
  }

  // ── Strip <think> XML blocks from text (DeepSeek API-style output) ────────────
  function stripThinkingText(text) {
    return text
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .trim();
  }

  // ── Get latest assistant message ─────────────────────────────────────────────
  function getLatestAssistantMessage() {
    try {
      const containers = document.querySelectorAll(CONFIG.messageContainer);
      if (!containers.length) return '';

      // Get the LAST message (most recent)
      const el = containers[containers.length - 1];
      const text = extractRawText(el).trim();

      if (text && text.length > 10) {
        return text;
      }
    } catch (e) {
      console.warn('[VibeBridge] Error getting message:', e.message);
    }

    return '';
  }

  // ── Token detection for streaming ─────────────────────────────────────────────
  function detectTokenType(text) {
    if (text.match(/```\w*\s*$/)) return 'code_start';
    if (text.includes('\n```') || text.match(/\n```\s*$/)) return 'code_end';
    return 'text';
  }

  // ── Clear all timers ────────────────────────────────────────────────────────
  function clearAllTimers() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (stabilityCheckTimer) {
      clearInterval(stabilityCheckTimer);
      stabilityCheckTimer = null;
    }
    stabilityRound = 0;
  }

  // ── Schedule stability check ──────────────────────────────────────────────────
  // Only called after 3000ms of NO text changes
  function scheduleStabilityCheck() {
    stabilityRound = 0;
    lastStableText = lastSeenText;

    console.log('[VibeBridge] Starting stability check, text length:', lastSeenText.length);

    // 4 rounds at 250ms = 1000ms total stability required
    stabilityCheckTimer = setInterval(() => {
      const currentText = getLatestAssistantMessage();

      if (currentText === lastStableText) {
        stabilityRound++;
        console.log(`[VibeBridge] Stability check round ${stabilityRound}/4 - text unchanged`);

        if (stabilityRound >= 4) {
          // Text has been stable for ~4 seconds
          console.log('[VibeBridge] Text stable for 4 rounds, triggering stream-end');
          clearAllTimers();
          // Double-check not still generating
          if (!CONFIG.isGenerating()) {
            fireStreamEnd();
          }
        }
      } else {
        // Text changed, restart stability check
        console.log('[VibeBridge] Text changed during stability check, restarting');
        clearAllTimers();
        lastStableText = currentText;
        lastSeenText = currentText;
        // Re-schedule debounce
        scheduleDebounce();
      }
    }, 250);
  }

  // ── Schedule debounce ───────────────────────────────────────────────────────
  // 3000ms debounce - resets on EVERY text change
  function scheduleDebounce() {
    clearAllTimers();

    console.log('[VibeBridge] Scheduling 3000ms debounce');

    debounceTimer = setTimeout(() => {
      console.log('[VibeBridge] Debounce fired, starting stability check');
      scheduleStabilityCheck();
    }, 3000);
  }

  // ── FIRE STREAM END (only once!) ─────────────────────────────────────────────
  function fireStreamEnd() {
    // CRITICAL: Hard guard - can only fire once per stream
    if (streamEndFired) {
      console.log('[VibeBridge] Stream-end already fired, ignoring');
      return;
    }

    if (!isStreaming) {
      console.log('[VibeBridge] Not streaming, ignoring stream-end');
      return;
    }

    streamEndFired = true;
    console.log('[VibeBridge] >>> FIRING STREAM END <<<');

    isStreaming = false;
    clearAllTimers();

    // CRITICAL FIX: prefer rawMarkdownBuffer (captured from fetch interception)
    // over accumulatedText (built from rendered DOM text, which strips fences).
    // The DOM-extracted text NEVER contains ``` fences or // FILENAME: directives
    // because the markdown renderer removes them. We need the raw response text
    // so the server can parse code blocks and file write directives correctly.
    const bestFullText = (rawMarkdownBuffer && rawMarkdownBuffer.length > accumulatedText.length)
      ? rawMarkdownBuffer
      : accumulatedText;

    console.log(`[VibeBridge] fullText source: ${rawMarkdownBuffer.length > accumulatedText.length ? 'raw fetch intercept' : 'DOM accumulation'} (${bestFullText.length} chars)`);

    // Extract actions from best text (for local logging only)
    const actions = parseActions(bestFullText);

    if (actions.length > 0) {
      console.log('[VibeBridge] Found', actions.length, 'actions to execute');
      actions.forEach((action, i) => {
        console.log(`  Action ${i + 1}: ${action.type} - ${action.params?.path || action.params?.command?.slice(0, 50) || ''}`);
      });
    }

    // Send stream-end message with full accumulated text
    chrome.runtime.sendMessage({
      type: 'VIBE_STREAM_END',
      streamId: currentStreamId,
      fullText: bestFullText,
      tokenCount: tokenCount,
      duration: Date.now() - streamStartTime,
      source: SOURCE,
      platform: PLATFORM
    });

    // Reset state for next stream - CRITICAL: clear lastSeenText AND rawMarkdownBuffer
    accumulatedText = '';
    rawMarkdownBuffer = '';     // CRITICAL: clear for next stream
    currentStreamId = null;
    tokenCount = 0;
    lastSeenText = '';          // CRITICAL: clear for next stream

    console.log('[VibeBridge] Stream reset complete, lastSeenText and rawMarkdownBuffer cleared');
  }

  // ── Parse actions from text ──────────────────────────────────────────────────
  // NOTE: This is used only for local logging/preview in the content script.
  // The authoritative parsing happens server-side in parseActionsWithPartial().
  // Keep this in sync with server.js logic.
  const CMD_LANGS_CS = new Set(['bash', 'sh', 'shell', 'zsh', 'ps1', 'powershell', 'cmd', 'bat']);

  function parseActions(text) {
    const actions = [];

    // Strip <think>/<thinking> blocks
    const cleanText = text
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .trim();

    // Pattern 1: Complete fenced code blocks  ```lang\n// FILENAME: path\ncontent\n```
    const completeFenceRe = /```(\w*)\s*\n([\s\S]*?)```/g;
    for (const match of cleanText.matchAll(completeFenceRe)) {
      const lang = (match[1] || '').toLowerCase().trim();
      const blockContent = match[2];

      // Shell fence → execute entire block as command
      if (CMD_LANGS_CS.has(lang)) {
        const cmd = blockContent.trim();
        if (cmd) actions.push({ type: 'execute_command', params: { command: cmd } });
        continue;
      }

      const lines = blockContent.split('\n');
      const firstLine = lines[0].trim();

      // // FILENAME: directive
      const filenameMatch = firstLine.match(/^\/\/\s*FILENAME:\s*(.+)$/i);
      if (filenameMatch) {
        const filePath = filenameMatch[1].trim();
        let content = lines.slice(1).join('\n');
        // Strip ALL leading blank lines (AI sometimes inserts blank line after // FILENAME:)
        while (content.startsWith('\n')) content = content.slice(1);
        if (content.endsWith('\n')) content = content.slice(0, -1);
        if (filePath && content.trim()) {
          actions.push({ type: 'write_file', params: { path: filePath, content, language: lang } });
        }
        continue;
      }

      // // COMMAND: directive
      const cmdDirective = firstLine.match(/^\/\/\s*COMMAND:\s*(.+)$/i);
      if (cmdDirective) {
        const cmd = cmdDirective[1].trim();
        if (cmd) actions.push({ type: 'execute_command', params: { command: cmd } });
        continue;
      }

      // Generic path comment: // src/file.ext  or  # src/file.ext
      const pathComment = firstLine.match(/^(?:\/\/|#)\s*([\w./-]+\.\w+)\s*$/);
      if (pathComment) {
        const filePath = pathComment[1].trim();
        let content = lines.slice(1).join('\n');
        // Strip ALL leading blank lines
        while (content.startsWith('\n')) content = content.slice(1);
        if (content.endsWith('\n')) content = content.slice(0, -1);
        if (filePath && content.trim() && content.length > 5) {
          actions.push({ type: 'write_file', params: { path: filePath, content, language: lang } });
        }
      }
    }

    // Pattern 2: Standalone // COMMAND: lines outside code blocks
    const noCodeBlocks = cleanText.replace(/```[\s\S]*?```/g, '');
    const cmdLineRe = /^[ \t]*\/\/\s*COMMAND:\s*(.+)$/gim;
    for (const match of noCodeBlocks.matchAll(cmdLineRe)) {
      const cmd = match[1].trim();
      if (cmd) actions.push({ type: 'execute_command', params: { command: cmd } });
    }

    return actions;
  }

  // ── Process text change ───────────────────────────────────────────────────────
  function processTextChange(rawText) {
    if (!rawText) return;

    // Strip <think>/<thinking> blocks from DeepSeek R1 and similar models.
    // These are reasoning/chain-of-thought tokens — never action content.
    const newText = stripThinkingText(rawText);
    if (!newText) return;

    // Check if this is genuinely new text
    if (newText === lastSeenText) return;

    const newContent = newText.slice(lastSeenText.length);

    // ── Stream START detection ──────────────────────────────────────────────
    if (!isStreaming && newText.length > 0) {
      console.log('[VibeBridge] >>> STREAM START <<<');
      isStreaming = true;
      streamEndFired = false;  // Reset guard
      streamStartTime = Date.now();
      currentStreamId = generateStreamId();
      tokenCount = 0;
      accumulatedText = '';

      chrome.runtime.sendMessage({
        type: 'VIBE_STREAM_START',
        streamId: currentStreamId,
        source: SOURCE,
        platform: PLATFORM
      });
    }

    // ── Accumulate and send chunk ────────────────────────────────────────────
    if (newContent) {
      tokenCount += newContent.length;
      accumulatedText += newContent;

      chrome.runtime.sendMessage({
        type: 'VIBE_STREAM_CHUNK',
        data: {
          text: newContent,
          fullText: newText,
          accumulatedText: accumulatedText,
          type: detectTokenType(newText),
          timestamp: Date.now(),
          streamId: currentStreamId
        },
        source: SOURCE
      });

      console.log(`[VibeBridge] Chunk: +${newContent.length} chars, total: ${accumulatedText.length}`);
    }

    lastSeenText = newText;

    // ── Reset debounce on EVERY text change ──────────────────────────────────
    // This is the key fix - any pause < 3s just restarts the timer
    if (isStreaming) {
      scheduleDebounce();
    }
  }

  // ── Check for stream completion ───────────────────────────────────────────────
  function checkStreamComplete() {
    if (!isStreaming || streamEndFired) return;

    // Check if AI is still generating
    if (CONFIG.isGenerating()) {
      return; // Still generating, don't fire
    }

    // AI stopped generating - trigger the flow
    console.log('[VibeBridge] AI stopped generating, initiating debounce');
    scheduleDebounce();
  }

  // ── Message listener (from background) ─────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'VIBE_INJECT') {
      console.log('[VibeBridge] Injecting text into chat');
      injectText(msg.text, msg.autoSend);
    }

    if (msg.type === 'VIBE_FILE_CHUNK') {
      console.debug('[VibeBridge] File chunk:', msg.path);
    }

    if (msg.type === 'VIBE_FILE_COMPLETE') {
      console.log('[VibeBridge] File written:', msg.path, msg.bytes, 'bytes');
    }

    if (msg.type === 'VIBE_COMMAND_RESULT') {
      console.log('[VibeBridge] Command result:', msg.exitCode, msg.output?.slice(0, 100));
      // Inject command result back into chat
      if (msg.output) {
        const resultText = `<tool_result>\n<output>${msg.output}</output>\n<exit_code>${msg.exitCode}</exit_code>\n</tool_result>`;
        injectText(resultText, true);
      }
    }

    if (msg.type === 'VIBE_ACTION_RESULT') {
      console.log('[VibeBridge] Action result:', msg.action?.type, msg.result);
    }
  });

  // ── Mutation Observer Setup ──────────────────────────────────────────────────
  const observer = new MutationObserver((mutations) => {
    const text = getLatestAssistantMessage();

    // Always process text changes
    if (text && text !== lastSeenText) {
      processTextChange(text);
    }

    // Check if streaming just completed
    if (isStreaming && !streamEndFired) {
      checkStreamComplete();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: true
  });

  // ── Periodic check for slow updates ─────────────────────────────────────────
  setInterval(() => {
    const text = getLatestAssistantMessage();
    if (text && text !== lastSeenText) {
      processTextChange(text);
    }
  }, 500);

  console.log(`[VibeBridge v13.1] Stream capture active for ${PLATFORM} - debounce: 3000ms, stability check: 4 rounds`);
  console.log('[VibeBridge] fetch() intercepted for raw markdown capture (fixes empty file bug)');
  console.log('[VibeBridge] Platform config:', JSON.stringify({ generating: CONFIG.isGenerating.toString(), container: CONFIG.messageContainer }));

})();
