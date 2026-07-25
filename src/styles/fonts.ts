/**
 * Self-hosted web fonts, bundled into the app (Fontsource, OFL-licensed).
 *
 * These used to load from fonts.googleapis.com, which is unreachable in some
 * regions and made the render-blocking (later async) request pointless — a
 * local-first app shouldn't need the network to look right. The latin subsets
 * cover everything these Latin-only faces actually render; CJK text falls
 * through to the system stacks declared in tokens.css (Songti/PingFang/YaHei).
 *
 * Weights mirror the old Google Fonts request:
 *   Spectral 200/300/400/500/600 + 400 italic · Inter Tight 400–700 ·
 *   JetBrains Mono 400/500
 */

import "@fontsource/spectral/latin-200.css";
import "@fontsource/spectral/latin-300.css";
import "@fontsource/spectral/latin-400.css";
import "@fontsource/spectral/latin-500.css";
import "@fontsource/spectral/latin-600.css";
import "@fontsource/spectral/latin-400-italic.css";

import "@fontsource/inter-tight/latin-400.css";
import "@fontsource/inter-tight/latin-500.css";
import "@fontsource/inter-tight/latin-600.css";
import "@fontsource/inter-tight/latin-700.css";

import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
