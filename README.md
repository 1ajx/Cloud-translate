# Cloud Translate — Browser Extension

A Chrome browser extension for AI-powered text selection translation. Bring your own API Key and switch freely between multiple cloud AI models (OpenAI, DeepSeek, Gemini, and more).

## Features

- **Select & Translate** — highlight any text on any webpage to instantly translate it
- **Multiple AI Models** — switch between OpenAI GPT, DeepSeek, Google Gemini, and other cloud models
- **Bring Your Own Key** — your API keys stay in your browser, never sent to a third-party server
- **Markdown Rendering** — responses support markdown, syntax highlighting, and LaTeX math
- **Chat Sidebar** — continue the conversation in a sidebar panel
- **Keyboard Shortcut** — `Ctrl+Shift+T` (or `Cmd+Shift+T` on Mac) to translate selection

## Installation

1. Clone or download this repository
2. Open Chrome/Eege and navigate to `chrome(Edge)://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. Open the extension options page and enter your API Key(s)

## Configuration

Go to the extension's **Options** page to:

- Add API Keys for each provider
- Set your preferred target language
- Customize the translation prompt

## Tech Stack

- Manifest V3 Chrome Extension
- Vanilla JavaScript (no framework)
- [marked.js](https://marked.js.org/) — Markdown rendering
- [highlight.js](https://highlightjs.org/) — Code syntax highlighting
- [KaTeX](https://katex.org/) — LaTeX math rendering

## License

MIT — see [LICENSE](LICENSE)
