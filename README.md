# Simple AI Writer

A modern, local-first desktop Markdown editor with AI writing assistance powered by your own knowledge base. Write smarter with contextual AI suggestions based on custom lore entities.

**Available on:** macOS • Windows • Linux

---

## Features

🎯 **Local-First Architecture**
- All data stored locally—no cloud sync required
- Multi-platform support via Tauri v2
- Works offline; AI features require configured providers

📝 **Rich Markdown Editor**
- CodeMirror 6 with GitHub Flavored Markdown (GFM)
- Live split/preview modes with KaTeX math rendering
- Syntax highlighting and line wrapping
- Word/character count tracking

🧠 **AI Writing Assistance**
- **Task-based workflows**: Continue • Polish • Rewrite • Summarize • Custom
- **RAG-powered context**: Automatically surfaces relevant lore entities
- **Multi-provider support**: OpenAI • Google Gemini (or any OpenAI-compatible API)
- **Token tracking**: Monitor API usage and costs per session

📚 **Lore Knowledge Base**
- Create organized entity folders with Markdown summaries
- Alias-based entity matching for smart context retrieval
- 4-layer context assembly (system prompt → lore → document → task)
- Fast keyword scanning without embeddings

⚙️ **Provider & Model Management**
- Add multiple AI providers with API key security
- Auto-fetch available models from provider APIs
- Create custom prompt templates for different writing tasks
- Secure key storage with argon2 KDF encryption

💾 **Export & Share**
- **Markdown**: Copy to clipboard
- **HTML**: Self-contained file with inline CSS
- **PDF**: System print dialog (macOS/Windows/Linux)

🌐 **Internationalization**
- English & 中文 (Simplified Chinese) built-in
- Easy to add more languages via i18next

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Desktop** | Tauri v2 (Rust backend) |
| **Frontend** | React 18 + TypeScript + Vite |
| **Editor** | CodeMirror 6 |
| **Preview** | markdown-it + KaTeX |
| **State** | Zustand |
| **Database** | SQLite (tauri-plugin-sql) |
| **Crypto** | tauri-plugin-stronghold (argon2) |
| **i18n** | react-i18next |
| **Styling** | CSS Modules + CSS Variables (dark/light theme) |

---

## Installation

### Prerequisites
- **Node.js** 18+ & pnpm
- **Rust** 1.70+ (for Tauri)
- macOS 11+, Windows 10+, or modern Linux

### Development Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/simple-ai-writer.git
cd simple-ai-writer

# Install dependencies
pnpm install

# Start dev server with hot reload
pnpm tauri dev
```

### Build for Release

```bash
# macOS (dmg)
pnpm tauri build -- --target universal-apple-darwin

# Windows (msi)
pnpm tauri build -- --target x86_64-pc-windows-msvc

# Linux (appimage)
pnpm tauri build -- --target x86_64-unknown-linux-gnu
```

Binaries will be in `src-tauri/target/release/bundle/`.

---

## Quick Start

1. **Open or create a project**
   - Click "Open Project" to select or scaffold a new workspace
   - Auto-creates `writing/`, `lore/`, and `project.db`

2. **Write content**
   - Create/edit Markdown files in the left sidebar
   - Toggle Editor ⟷ Preview ⟷ Split view in toolbar

3. **Set up AI (optional)**
   - Click ⚙ (Settings) → **Providers** tab
   - Add OpenAI or Gemini API key and base URL
   - Go to **Models** tab → click model provider → fetch available models
   - (Optional) **Prompts** tab to create custom writing templates

4. **Use AI features**
   - Highlight text in editor
   - Open **AI** panel (right sidebar)
   - Select a task (Continue, Polish, Rewrite, Summarize, or Custom)
   - Watch streaming output, then "Insert to Document" or start over

5. **Manage lore**
   - Create folders in `lore/` with entity Markdown files
   - Each folder = one entity with `index.md` summary + aliases file
   - AI automatically surfaces matching entities in context

6. **Export**
   - Click **Export** → Choose format (Markdown, HTML, PDF)
   - Save or copy output

---

## Project Structure

```
simple-ai-writer/
├── src/
│   ├── components/        # React components
│   │   ├── editor/        # CodeMirror wrapper, Preview
│   │   ├── layout/        # SideTabBar, Sidebar, EditorArea, RightPanel, StatusBar
│   │   ├── ai/            # AiPanel (task UI, streaming output)
│   │   ├── lore/          # LorePanel (entity browser)
│   │   └── settings/      # SettingsModal (provider/model/prompt config)
│   ├── stores/            # Zustand stores
│   │   ├── projectStore   # Project & file tree state
│   │   ├── editorStore    # Editor content, selection, save state
│   │   ├── loreStore      # Lore entity index
│   │   ├── aiStore        # Provider/model/prompt config
│   │   ├── aiTaskStore    # Running AI task state
│   │   └── keyStore       # Stronghold API key vault
│   ├── lib/               # Business logic
│   │   ├── project.ts     # File tree, scaffolding, DB init
│   │   ├── markdown.ts    # Rendering (preview + export)
│   │   ├── fileio.ts      # Tauri fs commands
│   │   ├── db.ts          # SQLite schema & queries
│   │   ├── rag.ts         # Context assembly, entity matching
│   │   ├── aiClient.ts    # SSE streaming for OpenAI/Gemini
│   │   └── export.ts      # Markdown/HTML/PDF export
│   ├── i18n/              # Translation files (en, zh-CN)
│   └── App.tsx            # Root component
├── src-tauri/
│   ├── src/
│   │   └── lib.rs         # Tauri setup hooks, stronghold init
│   └── capabilities/      # Permission scopes
├── pnpm-lock.yaml
└── package.json
```

---

## Configuration

### API Keys & Providers

Keys are stored securely in the Stronghold vault (`~/.config/simple-ai-writer` on Linux, platform-specific on macOS/Windows).

**Adding a provider:**
1. Open Settings ⚙ → Providers
2. Name (e.g., "OpenAI", "My Gemini")
3. Base URL (e.g., `https://api.openai.com/v1`)
4. Standard (OpenAI or Gemini format)
5. Paste API key → Save

**Fetching models:**
1. Settings → Models → Click provider name → "Fetch from API"
2. Select models to enable

### Lore Entity Format

Create a folder under `lore/` with this structure:

```
lore/
└── EntityName/
    ├── index.md          # Main summary (rendered in preview)
    └── aliases.txt       # One alias per line (for context matching)
```

Example `index.md`:
```markdown
# Alice

Alice is the protagonist of the story...

## Background
Born in...

## Personality
She is...
```

Example `aliases.txt`:
```
Alice Cooper
main character
protagonist
```

---

## Development

### Project Commands

```bash
pnpm dev           # Start dev server
pnpm build         # Build frontend
pnpm tsc --noEmit  # Type-check without emit
pnpm tauri dev     # Run Tauri dev (hot reload)
pnpm tauri build   # Build release binaries
```

### Database Schema

Initialized in `src/lib/db.ts`:
- `settings` — App configuration
- `lore_entities` — Indexed entity folders and aliases
- `providers` — API provider configs (name, baseUrl, standard)
- `models` — Available models (id, name, provider_id)
- `prompts` — Custom writing templates (id, name, template, task)
- `token_usage` — Tracking API calls (model_id, task, prompt_tokens, completion_tokens, cost_usd, created_at)

### Adding a New Language

1. Copy `src/i18n/locales/en.json` to `src/i18n/locales/[lang].json`
2. Translate values
3. Update `src/i18n/config.ts` to include the new language
4. Restart dev server

### Debugging

- **Frontend**: Chrome DevTools (Ctrl/Cmd+Shift+I in dev mode)
- **Rust backend**: Use `println!()` macros; output in terminal
- **Database**: Check SQLite at `~/.config/simple-ai-writer/project.db` with `sqlite3`

---

## Usage Examples

### Writing a story chapter

1. Open `lore/` and add character entities with backstories
2. Create a new file in `writing/chapter1.md`
3. Start typing the opening scene
4. Select key plot points → AI panel → "Continue" → watch AI extend your narrative
5. Click "Insert to Document" to add the output
6. Refine with "Polish" or "Rewrite" tasks

### Creating marketing copy

1. Set up a "Marketing" prompt in Settings with brand guidelines
2. Draft headline in editor
3. Select it → AI panel → choose "Marketing" prompt
4. Customize instruction: "Make it punchier"
5. Insert result, iterate

### Summarizing research notes

1. Paste research into a new file
2. Select paragraphs → AI panel → "Summarize"
3. Adjust output length via custom instruction
4. Export as HTML for sharing

---

## Contributing

We welcome contributions! Here's how:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m "Add amazing feature"`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request with a clear description

### Reporting Issues

Please file bugs or feature requests at [GitHub Issues](https://github.com/yourusername/simple-ai-writer/issues) with:
- OS and app version
- Steps to reproduce
- Expected vs. actual behavior
- Screenshots (if applicable)

---

## Roadmap (V1.1+)

- [ ] WYSIWYG editor mode toggle
- [ ] Image generation from text prompts
- [ ] Prompt auto-optimization
- [ ] Multi-provider request routing
- [ ] Custom CSS themes
- [ ] Collaborative editing (optional sync backend)
- [ ] More language support

---

## License

This project is licensed under the **MIT License** — see [LICENSE](./LICENSE) for details.

You are free to use, modify, and distribute this software for personal and commercial purposes.

---

## Acknowledgments

Built with ❤️ using:
- [Tauri](https://tauri.app) — Lightweight desktop framework
- [React](https://react.dev) — UI library
- [CodeMirror](https://codemirror.net) — Advanced code editor
- [Zustand](https://zustand.docs.pmnd.io) — State management
- [markdown-it](https://markdown-it.github.io) — Markdown parser
- [KaTeX](https://katex.org) — Math typesetting

---

## Support

Have questions? Check the [GitHub Discussions](https://github.com/yourusername/simple-ai-writer/discussions) or open an [issue](https://github.com/yourusername/simple-ai-writer/issues).

Follow for updates: [GitHub](https://github.com/yourusername/simple-ai-writer)
