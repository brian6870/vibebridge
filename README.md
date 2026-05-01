# VibeBridge

VibeBridge is a local developer tool that bridges AI chat interfaces with a filesystem-aware local server. It consists of a Chrome extension plus a Node.js server that captures streaming AI responses, parses file and command actions, and writes files into your workspace.

## Project structure

- `chrome-extension/` - Browser extension source files
  - `manifest.json` - Chrome extension manifest
  - `background.js` - Extension service worker and SSE plumbing
  - `popup.html` - Extension popup UI
  - `popup.js` - Popup controls and live server status
  - `content-scripts/stream-capture.js` - AI chat response capture and injection logic
  - `prompt.md` - System prompt injected into supported AI chat pages
- `files/` - Local server tooling
  - `package.json` - Node package manifest
  - `server.js` - VibeBridge local server entrypoint

## What it does

VibeBridge enables a real-time agentic coding workflow by:

- intercepting streaming AI responses from supported chat pages
- extracting raw markdown and file-write directives
- forwarding actions to a local server via HTTP/SSE
- executing commands and writing files in the workspace root
- sending execution confirmations back into the chat interface

Supported chat domains include (but are not limited to):

- `chat.openai.com`
- `*.chatgpt.com`
- `*.claude.ai`
- `chat.deepseek.com`
- `*.gemini.google.com`
- `*.qwen.ai`
- `*.tongyi.aliyun.com`
- `*.perplexity.ai`
- `*.cohere.com`
- `*.mistral.ai`

## Requirements

- Node.js `>=16`
- Chrome or Chromium-based browser supporting Manifest V3 extensions
- Windows Subsystem for Linux (WSL) for best efficiency and compatibility

## Installation

1. Open a terminal and navigate to the `files/` folder:

   ```bash
   cd files
   ```

2. Start the local server:

   ```bash
   node server.js
   ```

   To enable automatic approval mode, run:

   ```bash
   node server.js --auto-approve
   ```

3. Load the Chrome extension unpacked:

   - Open `chrome://extensions`
   - Enable `Developer mode`
   - Click `Load unpacked`
   - Select the `chrome-extension/` folder

4. Open the extension popup and confirm the server connection.

## Usage

1. Start the local server first.
2. Load the extension unpacked.
3. Open any supported AI chat page.
4. Use the extension popup to check connection status and port.
5. Interact with the AI assistant using VibeBridge prompts and file directives.

## Configuration

- The local server listens on port `3172` by default.
- The extension popup allows updating the port and enabling `auto-approve` behavior.
- `prompt.md` contains the injected system prompt for AI chat pages.

## Notes

- The server writes files into the workspace root directory, not a nested `/workspace` folder.
- On first run, the server may create or update a root `.gitignore` file to exclude VibeBridge-managed files.
- The extension uses the browser runtime and content script to capture streamed AI output before it is rendered.

## License

MIT
