# Simple AI Writer

[![CI](https://github.com/Joycai/simple-ai-writer/actions/workflows/ci.yml/badge.svg)](https://github.com/Joycai/simple-ai-writer/actions/workflows/ci.yml)
[![Release](https://github.com/Joycai/simple-ai-writer/actions/workflows/release.yml/badge.svg)](https://github.com/Joycai/simple-ai-writer/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/Joycai/simple-ai-writer?sort=semver)](https://github.com/Joycai/simple-ai-writer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](#install)

[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)](https://vite.dev)

A local-first desktop writing workspace that combines a Markdown editor, a project knowledge base, and an approval-gated AI agent. It is designed for long-form writing and document work where source files, context, and generated results should remain under the author's control.

**Runs on macOS, Windows, and Linux.** The editor and project data are local. Network access is used only when you call a configured AI provider or opt into the companion sync server.

---

## What it does

### Write in a real local workspace

- Edit Markdown, text, and HTML files directly inside any folder you choose.
- Use editor, preview, and split views with GFM, KaTeX, Mermaid, syntax highlighting, zoom, and linked scrolling.
- Organize files freely, or use the Library view for grouped long-form documents, rolling summaries, and cross-document continuity.
- Search documents, knowledge-base entries, and the current file from the command palette.
- Keep project metadata beside the work in `.ai-writer/`; there is no proprietary document container.

### Bring your own AI

- Connect official or compatible endpoints for four protocol families:
  - OpenAI Chat Completions
  - OpenAI Responses
  - Google Gemini
  - Anthropic Messages
- Use hosted providers, gateways, or local servers such as Ollama and LM Studio.
- Configure models by capability, including text, vision, PDF input, video input, image generation, translation, and speech recognition.
- Keep API keys in the operating system credential manager rather than in project files or SQLite.
- Track token usage and configured costs per model call.

### Use task workflows or the full agent

Built-in neutral tasks include Continue, Rewrite, Polish, Summarize, HTML Artifact, and Custom. Projects can add domain-specific tasks through capability packs.

The unified agent runtime can:

- search and read project files, HTML pages, slide decks, and knowledge-base entries;
- propose precise edits or full-document rewrites;
- create files and hand work to specialized subagents;
- load less-common tool groups — file organizing (rename, move, copy, delete) and image generation/editing — on demand through `search_tools`, keeping the default tool list small enough for local models;
- maintain notes, compact long conversations, rewind chats, and resume persisted long-running tasks;
- ask the author questions and pause at round limits instead of silently guessing;
- show approval cards before protected edits, conversions, exports, transcription, or command execution.

The task panel and conversational assistant share the same runtime and execution log. Multiple chat sessions can remain available at once.

### Build a structured knowledge base

Knowledge-base entries live as Markdown under `.ai-writer/lore/<category>/<entry>/` and can include:

- aliases and frontmatter metadata;
- independently activated facets with keys, groups, priority, and injection modes;
- collections that narrow discovery without changing the underlying data;
- image galleries and per-category image slots;
- citations that navigate back to the source entry.

Context assembly combines the current task, document focus, relevant entries, recent material, rolling memory, and optional book-spine summaries. Retrieval is local and does not require an embedding service.

### Adapt the workspace with capability packs

A project can enable any number of additive packs—or none. Built-in packs currently cover:

- Novel
- TTRPG module
- Copywriting
- WeChat articles
- Weekly reports
- Feedback reports
- Bid responses

Each pack contributes task definitions and knowledge-base categories without changing the app-wide document model or vocabulary. The selection is stored in `.ai-writer/profile.json` and can be changed later.

### Import, export, illustrate, and back up

**Import**

- Convert `.docx`, `.xlsx`, `.pdf`, and `.pptx` into editable Markdown.
- Copy Markdown, text, HTML, images, audio, and video into the workspace without modifying the source file.
- Preserve extracted images beside converted documents.

**Export**

- Copy Markdown.
- Export self-contained HTML.
- Print or save as PDF through the system print dialog.
- Generate and edit document illustrations with configured image models; assets use relative links inside the project.

**Back up and sync**

- Export or restore a whole-project archive.
- Export or import app configuration separately; including API keys is an explicit opt-in and local JSON exports must be protected.
- Encrypt server-side configuration backups whenever API keys are included.
- Optionally run the standalone `server/` companion for one-direction-at-a-time knowledge-base sync and versioned app-configuration backups. The desktop app never requires this server.

---

## Experimental features

Settings → AI Configuration → Lab contains features that are **off by default**. When disabled, their entry points and agent tools are absent rather than shown as permanently unavailable.

- PPTX export from HTML slides
- Word (`.docx`) export with reusable typography presets
- Excel (`.xlsx`) export from Markdown tables
- Interactive first-person roleplay with narrator handoff
- Assistant tool-pack orchestration
- Structured state memory for very long chats
- Sakura-style Japanese-to-Chinese translation through a local compatible endpoint
- Local ComfyUI image generation
- Qwen audio/video transcription with timestamps and optional diarization
- Local command execution with approval policy, aware of the host shell, OS version, and architecture

These features are usable but intentionally remain behind explicit opt-in because they add specialized models, local services, larger tool surfaces, or higher-risk actions.

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Desktop shell | Tauri v2 |
| Frontend | React 19, TypeScript 7, Vite 8 |
| Editor | CodeMirror 6 |
| Preview | markdown-it, KaTeX, Mermaid |
| State | Zustand |
| Motion | Motion |
| Project/config storage | SQLite |
| Secrets | OS credential manager through Rust `keyring` |
| Backend | Rust commands for scoped file I/O, Office formats, printing, key storage, and transactions |
| Optional sync server | Rust + axum |
| Localization | i18next; English and Simplified Chinese |
| Styling | CSS Modules plus a token-based theme system |

---

## Install

### Download a release

Download the installer for your platform from [GitHub Releases](https://github.com/Joycai/simple-ai-writer/releases):

| Platform | Artifacts |
| --- | --- |
| macOS | Universal `.dmg` |
| Windows | `.msi` or NSIS `.exe` |
| Linux | `.AppImage` or `.deb` |

Release builds are currently not code-signed. Your operating system may require an explicit first-run confirmation.

### Build from source

Prerequisites:

- a current Node.js LTS release;
- pnpm 10;
- the current Rust stable toolchain;
- the native prerequisites required by Tauri v2 for your platform.

Platform notes:

- **Windows:** install the Visual Studio C++ desktop workload and WebView2 Runtime.
- **macOS:** install Xcode Command Line Tools with `xcode-select --install`.
- **Linux:** install the WebKitGTK 4.1 and other Tauri build packages for your distribution.

```bash
git clone https://github.com/Joycai/simple-ai-writer.git
cd simple-ai-writer
pnpm install
pnpm tauri dev
```

Build installers for the current platform:

```bash
pnpm tauri build
```

`pnpm dev` starts only the Vite frontend on port `1420`. It is useful for UI work, but Tauri IPC features such as filesystem access, SQLite, the keyring, native dialogs, and printing will not work there. Use `pnpm tauri dev` for the normal development loop.

---

## Quick start

1. **Open a folder.** Simple AI Writer initializes `.ai-writer/` without moving or wrapping your existing documents.
2. **Choose capability packs.** Select any combination during onboarding or later in Settings → Workspace.
3. **Connect a provider.** Add a provider and model in Settings → Providers & Models, or configure a local endpoint.
4. **Write or import material.** Create Markdown files, import Office/PDF documents, or add images and recordings.
5. **Add knowledge.** Create entries in the Knowledge Base and organize details into facets or collections when useful.
6. **Call AI.** Select text for an edit task, run a continuation, open the assistant, or use the command palette.
7. **Review before applying.** Generated drafts, proposed edits, and protected actions stay visible until you accept them.

---

## Project data layout

A workspace remains an ordinary folder. App-owned project state is namespaced under `.ai-writer/`:

```text
my-project/
├── chapter-01.md
├── research/
├── assets/
└── .ai-writer/
    ├── project.db             # project-scoped usage and runtime data
    ├── profile.json           # enabled capability packs and custom categories
    ├── lore/                  # knowledge-base entries and galleries
    ├── memory/                # rolling context summaries
    ├── tasks/                 # resumable agent task state
    ├── roleplay/              # roleplay transcripts and memory areas
    ├── themes/                # project typography themes
    ├── workflows/             # project workflow overrides
    ├── backups/               # safety copies made before destructive writes
    └── tmp/                   # conversion and transcription caches
```

Installation-scoped provider, model, prompt, and preference data lives in `config.db` under the app data directory. API keys live separately in the OS credential manager.

---

## Repository map

```text
src/
├── components/        # editor, layout, AI cards/chat, knowledge base, settings, sync
├── stores/            # Zustand stores, one concern per store
├── lib/
│   ├── ai/            # provider protocols, streaming, model capabilities, usage
│   ├── agent/         # tool loop, approvals, routing, compaction, subagents
│   ├── context/       # RAG assembly, memory, document focus, clock
│   ├── lore/          # entry model, facets, collections, citations, galleries
│   ├── profile/       # capability packs and workspace profile resolution
│   ├── import/        # docx/xlsx/pdf/pptx → Markdown
│   ├── fs/            # scoped project I/O, Markdown rendering, export, backup
│   └── …              # docx, pptx, xlsx, roleplay, translation, ASR, themes, sync
├── i18n/locales/      # en and zh-CN
└── styles/            # design tokens and global cascade

src-tauri/             # Tauri/Rust desktop backend
server/                # optional standalone sync/config-backup server
docs/                  # living architecture, API, feature, and issue documentation
themes/                # example downloadable themes
```

For the maintained source map and subsystem invariants, read [`docs/reference/codemap.md`](docs/reference/codemap.md). [`docs/README.md`](docs/README.md) indexes all design and implementation documents with their current status.

---

## Development

### Frontend and desktop commands

```bash
pnpm install
pnpm tauri dev          # normal desktop development loop
pnpm dev                # browser UI only; native features are unavailable
pnpm exec tsc --noEmit  # strict TypeScript check; this is the lint gate
pnpm test               # Vitest
pnpm build              # type-check and build the frontend
pnpm tauri build        # release bundle for the current platform
```

### Rust checks

Run these from `src-tauri/`, and again from `server/` when changing the companion server:

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
cargo build
```

The pull-request gate runs the same checks. See [`docs/reference/ci.md`](docs/reference/ci.md) for the exact workflow and platform packages.

### Documentation for contributors

- [`AGENTS.md`](AGENTS.md) — repository rules, architecture overview, and required reading before changing a subsystem
- [`docs/reference/architecture.md`](docs/reference/architecture.md) — storage, RAG, providers, streaming, exports, IPC, and security details
- [`docs/reference/design-system.md`](docs/reference/design-system.md) — UI and theme contract
- [`docs/reference/terminology.md`](docs/reference/terminology.md) — author-facing vocabulary
- [`docs/reference/workflows.md`](docs/reference/workflows.md) — recipes for providers, packs, tasks, languages, and knowledge-base changes
- [`docs/reference/tool-presence.md`](docs/reference/tool-presence.md) — rules for exposing agent tools

When contributing, branch from `main` with a `feat/`, `fix/`, `chore/`, `docs/`, or `refactor/` prefix. Pull requests target `main`; the author merges after CI is green.

---

## Security and privacy model

- Project documents and knowledge-base files remain in the selected local folder.
- Filesystem commands are fenced to explicitly scoped paths by the Tauri backend.
- API credentials are stored in the OS credential manager.
- Provider requests go directly to the endpoint configured by the author.
- Protected writes and paid or high-risk actions use proposal/approval cards.
- Imported and converted source files are never modified in place.
- Optional sync is self-hosted and uses explicit push/pull plans; it is not live collaborative editing.

As with any bring-your-own-provider application, content sent to an AI endpoint is subject to that provider's privacy and retention policies.

---

## License

Simple AI Writer is available under the [MIT License](./LICENSE).
