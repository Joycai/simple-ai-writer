import { describe, expect, it, vi } from "vitest";

/**
 * The PPTX Beta switch, flipped by hand. It reads a preference, and in a node
 * test there is no localStorage behind one — mocking the accessor keeps the
 * gate itself under test instead of the preference store.
 */
const beta = { on: false };
vi.mock("../../pptx/flag", () => ({ isPptxExportEnabled: () => beta.on }));

/** Same, for the Word-export Beta. */
const docxBeta = { on: false };
vi.mock("../../docx/flag", () => ({ isDocxExportEnabled: () => docxBeta.on }));

/** Same, for the translation Beta. */
const translateBeta = { on: false };
vi.mock("../../translate/flag", () => ({ isTranslateEnabled: () => translateBeta.on }));

import { routePlannedTools, routeTools } from "../routing";
import type { TaskWorkspaceHandle } from "../taskWorkspace";

/** Bindings that satisfy every kind's precondition — routing is what's under test. */
const MODELS = [
  { id: "m-search", providerId: "p", modelId: "s", name: "S", type: "text",
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, serverTools: ["web_search"] },
  { id: "m-vision", providerId: "p", modelId: "v", name: "V", type: "multimodal",
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true },
  { id: "m-long", providerId: "p", modelId: "l", name: "L", type: "text",
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true },
  { id: "m-image", providerId: "p", modelId: "i", name: "I", type: "image",
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true },
  { id: "m-sakura", providerId: "p", modelId: "sakura", name: "Sakura", type: "text",
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, translateFormat: "sakura" },
] as never;

/** Stand-in handle: routeTools only tests it for presence. */
const WS: TaskWorkspaceHandle = { taskId: null, ensure: async () => ({ taskId: "t", dir: "/d" }) };
import { AGENT_ASSIST_PRESET } from "../presets";
import { withSessionOverrides, type SubAgentConfig, type SubAgentKind } from "../subagent";

describe("routeTools", () => {
  const allDisabled: Record<SubAgentKind, SubAgentConfig> = {
    search: { kind: "search", modelId: null, enabled: false },
    vision: { kind: "vision", modelId: null, enabled: false },
    longread: { kind: "longread", modelId: null, enabled: false },
    pdf: { kind: "pdf", modelId: null, enabled: false },
    imagegen: { kind: "imagegen", modelId: null, enabled: false },
    translate: { kind: "translate", modelId: null, enabled: false },
    writer: { kind: "writer", modelId: null, enabled: false },
    retrieval: { kind: "retrieval", modelId: null, enabled: false },
  };
  /**
   * The preset as it routes with nothing enabled: no drawing arm, no image
   * tools, and neither Beta export (a Beta feature is off until the author
   * says so — and off means the tool is absent, not refused).
   */
  const BASELINE_TOOLS = AGENT_ASSIST_PRESET.tools.filter(
    (t) => !["generate_image", "edit_image", "redraw_lore_image"].includes(t)
      && t !== "export_pptx"
      && t !== "export_docx"
      && t !== "read_doc_format",
  );

  it("keeps everything except the image tools when no subagents are active", () => {
    // The image tools are the imagegen subagent's — with no usable binding the
    // main model (which cannot draw) would only ever collect an error from them.
    const res = routeTools(AGENT_ASSIST_PRESET, allDisabled, WS, MODELS);
    expect(res.tools).toEqual(BASELINE_TOOLS);
    expect(res.serverTools).toBe("final-round-off");
  });

  it("disables serverTools on main agent when search subagent is active", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      search: { kind: "search", modelId: "m-search", enabled: true },
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS);
    expect(res.serverTools).toBe("off");
    expect(res.tools).toContain("delegate");
  });

  it("strips read_image and read_lore_image from main agent when vision subagent is active", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      vision: { kind: "vision", modelId: "m-vision", enabled: true },
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS);
    expect(res.tools).not.toContain("read_image");
    expect(res.tools).not.toContain("read_lore_image");
    expect(res.tools).toContain("delegate");
  });

  it("does not add delegate tool if hasWorkspace is false", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      search: { kind: "search", modelId: "m-search", enabled: true },
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, undefined, MODELS);
    expect(res.tools).not.toContain("delegate");
  });
  // ── "Enabled" is not "usable" ────────────────────────────────────────────

  it("ignores a search subagent whose model cannot browse", () => {
    // Acting on the flag alone took the MAIN model's browsing away
    // (serverTools: "off") and handed back a subagent that refuses — strictly
    // worse than leaving the switch alone.
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      search: { kind: "search", modelId: "m-long", enabled: true },  // no web_search
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS);
    expect(res.serverTools).toBe("final-round-off");
    expect(res.tools).not.toContain("delegate");
  });

  it("ignores a vision subagent bound to a text-only model", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      vision: { kind: "vision", modelId: "m-long", enabled: true },
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS);
    expect(res.tools).toContain("read_image");
    expect(res.tools).not.toContain("delegate");
  });

  it("ignores a subagent whose bound model was deleted", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      longread: { kind: "longread", modelId: "gone", enabled: true },
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS);
    expect(res.tools).not.toContain("delegate");
  });

  // ── Image generation ─────────────────────────────────────────────────────

  it("hands the image tools to a usable imagegen subagent", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      imagegen: { kind: "imagegen", modelId: "m-image", enabled: true },
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS);
    expect(res.tools).toContain("generate_image");
    expect(res.tools).toContain("edit_image");
    // Both editors, or neither: they are one capability split across two names
    // so the model can tell a gallery picture from a file.
    expect(res.tools).toContain("redraw_lore_image");
  });

  it("does not add delegate for imagegen alone — it has no conversational sub-run", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      imagegen: { kind: "imagegen", modelId: "m-image", enabled: true },
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS);
    expect(res.tools).not.toContain("delegate");
  });

  it("ignores an imagegen subagent bound to a text model", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      imagegen: { kind: "imagegen", modelId: "m-long", enabled: true },
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS);
    expect(res.tools).not.toContain("generate_image");
  });

  it("keeps drawing and seeing independent — vision strips reads, not draws", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      vision: { kind: "vision", modelId: "m-vision", enabled: true },
      imagegen: { kind: "imagegen", modelId: "m-image", enabled: true },
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS);
    expect(res.tools).not.toContain("read_image");
    expect(res.tools).toContain("generate_image");
  });

  // ── Session chips ────────────────────────────────────────────────────────

  it("a chip switched off this conversation takes the routing with it", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      search: { kind: "search", modelId: "m-search", enabled: true },
      vision: { kind: "vision", modelId: "m-vision", enabled: true },
    };
    const on = routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS);
    expect(on.serverTools).toBe("off");
    expect(on.tools).not.toContain("read_image");

    // Disabling search must hand browsing back to the main model; disabling
    // vision must hand the image tools back. This is the whole point of the
    // chips — the composer and the delegate resolver read the same value.
    const off = routeTools(
      AGENT_ASSIST_PRESET,
      withSessionOverrides(subs, ["search", "vision"]),
      WS,
      MODELS,
    );
    expect(off.serverTools).toBe("final-round-off");
    expect(off.tools).toContain("read_image");
    expect(off.tools).not.toContain("delegate");
  });

  it("session overrides only subtract — a chip cannot enable what Settings did not", () => {
    const restored = withSessionOverrides(allDisabled, []);
    expect(routeTools(AGENT_ASSIST_PRESET, restored, WS, MODELS).tools)
      .toEqual(BASELINE_TOOLS);
    // And an override for a kind that was never on is a no-op, not a toggle-on.
    const stillOff = withSessionOverrides(allDisabled, ["search"]);
    expect(stillOff.search.enabled).toBe(false);
  });

  it("an imagegen chip switched off takes the image tools with it", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      imagegen: { kind: "imagegen", modelId: "m-image", enabled: true },
    };
    const off = routeTools(
      AGENT_ASSIST_PRESET,
      withSessionOverrides(subs, ["imagegen"]),
      WS,
      MODELS,
    );
    expect(off.tools).not.toContain("generate_image");
    expect(off.tools).not.toContain("edit_image");
    expect(off.tools).not.toContain("redraw_lore_image");
  });

  // ── Planned routing (estimation before the run) ──────────────────────────

  it("routePlannedTools predicts delegate without needing a handle", () => {
    // The chat surface creates its workspace at run start, so an estimate
    // taken while idle must match what routeTools produces once it exists.
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      search: { kind: "search", modelId: "m-search", enabled: true },
    };
    const planned = routePlannedTools(AGENT_ASSIST_PRESET, subs, MODELS);
    expect(planned.tools).toContain("delegate");
    expect(planned).toEqual(routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS));
  });

  it("routePlannedTools matches run-time routing with nothing enabled too", () => {
    expect(routePlannedTools(AGENT_ASSIST_PRESET, allDisabled, MODELS))
      .toEqual(routeTools(AGENT_ASSIST_PRESET, allDisabled, WS, MODELS));
  });
});

describe("the PPTX export Beta gate", () => {
  const allDisabled: Record<SubAgentKind, SubAgentConfig> = {
    search: { kind: "search", modelId: null, enabled: false },
    vision: { kind: "vision", modelId: null, enabled: false },
    longread: { kind: "longread", modelId: null, enabled: false },
    pdf: { kind: "pdf", modelId: null, enabled: false },
    imagegen: { kind: "imagegen", modelId: null, enabled: false },
    translate: { kind: "translate", modelId: null, enabled: false },
    writer: { kind: "writer", modelId: null, enabled: false },
    retrieval: { kind: "retrieval", modelId: null, enabled: false },
  };

  it("withholds export_pptx entirely while the switch is off", () => {
    // Absent rather than refused: a tool the model can see but that always
    // answers "not enabled" reads as the assistant being broken, and costs a
    // round to find out. Same rule the image tools follow.
    beta.on = false;
    expect(routeTools(AGENT_ASSIST_PRESET, allDisabled, WS, MODELS).tools).not.toContain("export_pptx");
  });

  it("offers it once the author turns it on", () => {
    beta.on = true;
    try {
      expect(routeTools(AGENT_ASSIST_PRESET, allDisabled, WS, MODELS).tools).toContain("export_pptx");
      // The estimator has to predict the same toolset, or the context meter
      // disagrees with the request that follows it.
      expect(routePlannedTools(AGENT_ASSIST_PRESET, allDisabled, MODELS).tools).toContain("export_pptx");
    } finally {
      beta.on = false;
    }
  });

  it("withholds both Word tools entirely while its own switch is off", () => {
    // read_doc_format goes too: on its own it can only answer about formats
    // nobody can export, which reads as the assistant being broken.
    docxBeta.on = false;
    const tools = routeTools(AGENT_ASSIST_PRESET, allDisabled, WS, MODELS).tools;
    expect(tools).not.toContain("export_docx");
    expect(tools).not.toContain("read_doc_format");
  });

  it("offers export_docx once the author turns it on", () => {
    docxBeta.on = true;
    try {
      expect(routeTools(AGENT_ASSIST_PRESET, allDisabled, WS, MODELS).tools).toContain("export_docx");
      expect(routeTools(AGENT_ASSIST_PRESET, allDisabled, WS, MODELS).tools).toContain("read_doc_format");
      expect(routePlannedTools(AGENT_ASSIST_PRESET, allDisabled, MODELS).tools).toContain("export_docx");
    } finally {
      docxBeta.on = false;
    }
  });

  it("the two Beta exports are independent switches", () => {
    // One Beta turning on must not drag the other in: they are separate
    // features and an author who wants slides has not asked for Word.
    beta.on = true;
    try {
      const tools = routeTools(AGENT_ASSIST_PRESET, allDisabled, WS, MODELS).tools;
      expect(tools).toContain("export_pptx");
      expect(tools).not.toContain("export_docx");
    } finally {
      beta.on = false;
    }
  });
});


describe("the translation gate", () => {
  const allDisabled: Record<SubAgentKind, SubAgentConfig> = {
    search: { kind: "search", modelId: null, enabled: false },
    vision: { kind: "vision", modelId: null, enabled: false },
    longread: { kind: "longread", modelId: null, enabled: false },
    pdf: { kind: "pdf", modelId: null, enabled: false },
    imagegen: { kind: "imagegen", modelId: null, enabled: false },
    translate: { kind: "translate", modelId: null, enabled: false },
    writer: { kind: "writer", modelId: null, enabled: false },
    retrieval: { kind: "retrieval", modelId: null, enabled: false },
  };
  const bound: Record<SubAgentKind, SubAgentConfig> = {
    ...allDisabled,
    translate: { kind: "translate", modelId: "m-sakura", enabled: true },
  };

  const withBeta = (on: boolean, run: () => void) => {
    translateBeta.on = on;
    try { run(); } finally { translateBeta.on = false; }
  };

  it("needs BOTH the Beta switch and a binding — neither alone offers the tool", () => {
    withBeta(false, () => {
      expect(routeTools(AGENT_ASSIST_PRESET, bound, WS, MODELS).tools).not.toContain("translate");
    });
    withBeta(true, () => {
      expect(routeTools(AGENT_ASSIST_PRESET, allDisabled, WS, MODELS).tools).not.toContain("translate");
    });
  });

  it("offers it when both are in place", () => {
    withBeta(true, () => {
      expect(routeTools(AGENT_ASSIST_PRESET, bound, WS, MODELS).tools).toContain("translate");
      // The estimator must predict the same toolset, or the context meter
      // disagrees with the request that follows it.
      expect(routePlannedTools(AGENT_ASSIST_PRESET, bound, MODELS).tools).toContain("translate");
    });
  });

  it("ignores a binding to an ordinary model", () => {
    // The failure this prevents is silent: a general model handed Sakura's
    // fixed template answers something plausible, so nothing errors and the
    // author reads a worse translation as the feature working.
    withBeta(true, () => {
      const subs: Record<SubAgentKind, SubAgentConfig> = {
        ...allDisabled,
        translate: { kind: "translate", modelId: "m-long", enabled: true },
      };
      expect(routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS).tools).not.toContain("translate");
    });
  });

  it("never adds delegate for translate alone — it holds no conversation", () => {
    withBeta(true, () => {
      expect(routeTools(AGENT_ASSIST_PRESET, bound, WS, MODELS).tools).not.toContain("delegate");
    });
  });

  it("needs no task workspace — nothing is written to one", () => {
    // Unlike `delegate`, whose findings have to land in a note somewhere.
    withBeta(true, () => {
      expect(routeTools(AGENT_ASSIST_PRESET, bound, undefined, MODELS).tools).toContain("translate");
    });
  });
});


/**
 * The writer is the one subagent that changes no tool at all — it changes how
 * the run *ends*. So the whole of its routing is one field, and every way of
 * getting that field wrong is a switch that silently does nothing.
 */
describe("routeTools — writer handoff", () => {
  const allDisabled: Record<SubAgentKind, SubAgentConfig> = {
    search: { kind: "search", modelId: null, enabled: false },
    vision: { kind: "vision", modelId: null, enabled: false },
    longread: { kind: "longread", modelId: null, enabled: false },
    pdf: { kind: "pdf", modelId: null, enabled: false },
    imagegen: { kind: "imagegen", modelId: null, enabled: false },
    translate: { kind: "translate", modelId: null, enabled: false },
    writer: { kind: "writer", modelId: null, enabled: false },
    retrieval: { kind: "retrieval", modelId: null, enabled: false },
  };
  const bound: Record<SubAgentKind, SubAgentConfig> = {
    ...allDisabled,
    writer: { kind: "writer", modelId: "m-long", enabled: true },
    retrieval: { kind: "retrieval", modelId: null, enabled: false },
  };

  it("keeps the preset's own ending when the surface has not opted in", () => {
    // Roleplay and the AiPanel run presets that never asked for this, and one
    // of them shares its preset object with the chat assistant.
    const res = routeTools(AGENT_ASSIST_PRESET, bound, WS, MODELS);
    expect(res.finishPolicy).toBe(AGENT_ASSIST_PRESET.finishPolicy);
  });

  it("keeps it when the surface opted in but nothing is bound", () => {
    const res = routeTools(AGENT_ASSIST_PRESET, allDisabled, WS, MODELS, { handoff: true });
    expect(res.finishPolicy).toBe("force-text");
  });

  it("hands off when the surface opted in and a usable writer is bound", () => {
    const res = routeTools(AGENT_ASSIST_PRESET, bound, WS, MODELS, { handoff: true });
    expect(res.finishPolicy).toBe("handoff");
  });

  it("ignores a binding to a model that cannot write prose", () => {
    // Enabled-but-unusable is the failure `subAgentModel` exists to catch, and
    // here it would leave the run with no ending anyone can produce.
    for (const modelId of ["m-image", "m-sakura"]) {
      const subs: Record<SubAgentKind, SubAgentConfig> = {
        ...allDisabled,
        writer: { kind: "writer", modelId, enabled: true },
        retrieval: { kind: "retrieval", modelId: null, enabled: false },
      };
      expect(routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS, { handoff: true }).finishPolicy)
        .toBe("force-text");
    }
  });

  it("changes nothing about the toolset", () => {
    const off = routeTools(AGENT_ASSIST_PRESET, allDisabled, WS, MODELS, { handoff: true });
    const on = routeTools(AGENT_ASSIST_PRESET, bound, WS, MODELS, { handoff: true });
    expect(on.tools).toEqual(off.tools);
    expect(on.serverTools).toBe(off.serverTools);
  });

  it("is switched off for this conversation by the session chip, like every other kind", () => {
    const subs = withSessionOverrides(bound, ["writer"]);
    expect(routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS, { handoff: true }).finishPolicy)
      .toBe("force-text");
  });

  it("needs no task workspace — the writer writes no notes", () => {
    expect(routeTools(AGENT_ASSIST_PRESET, bound, undefined, MODELS, { handoff: true }).finishPolicy)
      .toBe("handoff");
  });
});

/**
 * ask_author rides on whether the surface can render the question card — a
 * per-surface opt-in like `handoff`, appended like `translate`. Off must mean
 * ABSENT: a batch run blocked on an invisible card would hang the whole sweep.
 */
describe("routeTools — ask_author", () => {
  const allDisabled: Record<SubAgentKind, SubAgentConfig> = {
    search: { kind: "search", modelId: null, enabled: false },
    vision: { kind: "vision", modelId: null, enabled: false },
    longread: { kind: "longread", modelId: null, enabled: false },
    pdf: { kind: "pdf", modelId: null, enabled: false },
    imagegen: { kind: "imagegen", modelId: null, enabled: false },
    translate: { kind: "translate", modelId: null, enabled: false },
    writer: { kind: "writer", modelId: null, enabled: false },
    retrieval: { kind: "retrieval", modelId: null, enabled: false },
  };

  it("is absent unless the surface says it can render the question card", () => {
    expect(routeTools(AGENT_ASSIST_PRESET, allDisabled, WS, MODELS).tools)
      .not.toContain("ask_author");
    expect(routeTools(AGENT_ASSIST_PRESET, allDisabled, WS, MODELS, { askAuthor: false }).tools)
      .not.toContain("ask_author");
  });

  it("is appended when the surface opts in — in the planning view too", () => {
    expect(routeTools(AGENT_ASSIST_PRESET, allDisabled, WS, MODELS, { askAuthor: true }).tools)
      .toContain("ask_author");
    expect(routePlannedTools(AGENT_ASSIST_PRESET, allDisabled, MODELS, { askAuthor: true }).tools)
      .toContain("ask_author");
  });
});
