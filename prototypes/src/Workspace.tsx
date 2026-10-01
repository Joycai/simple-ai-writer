import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  BookOpen,
  Check,
  ChevronDown,
  FileText,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCcw,
  Search,
  Send,
  Sparkles,
} from "lucide-react";
import { Select } from "../../src/components/common/Select";
import { documents, suggestedParagraph } from "./fixtures";

type Document = (typeof documents)[number];
type Proposal = { target: string; before: string; after: string };
type Scenario = "writing" | "empty" | "error";
type Mode = "editor" | "preview" | "split";
const knowledge = [
  {
    title: "The old station",
    type: "Place",
    body: "East-facing windows, wooden benches, and a waiting room that catches the morning light.",
  },
  {
    title: "The observer",
    type: "Person",
    body: "A patient narrator who notices small gestures before drawing conclusions.",
  },
  {
    title: "A quieter voice",
    type: "Style",
    body: "Concrete details, short transitions, and enough room for the reader to infer the feeling.",
  },
];

export function Workspace() {
  const [files, setFiles] = useState<Document[]>(
    documents.map((item) => ({ ...item })),
  );
  const [activeId, setActiveId] = useState(documents[0].id);
  const [mode, setMode] = useState<Mode>("preview");
  const [scenario, setScenario] = useState<Scenario>("writing");
  const [sidebar, setSidebar] = useState(true);
  const [panel, setPanel] = useState<"documents" | "knowledge">("documents");
  const [filter, setFilter] = useState("");
  const [entry, setEntry] = useState(0);
  const [request, setRequest] = useState(
    "Make the opening paragraph more concise.",
  );
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [applied, setApplied] = useState<Proposal | null>(null);
  const [notice, setNotice] = useState("");
  const nextFile = useRef(1);
  const conversationRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (proposal && conversationRef.current) {
      conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
    }
  }, [proposal]);
  const current = files.find((item) => item.id === activeId)!;
  const setBody = (id: string, body: string) =>
    setFiles((items) =>
      items.map((item) => (item.id === id ? { ...item, body } : item)),
    );
  const openFile = (id: string) => {
    setActiveId(id);
    setProposal(null);
    setNotice("");
  };
  const newFile = () => {
    const n = nextFile.current++;
    const file = {
      id: `new-${n}`,
      name: `Untitled ${n}.md`,
      title: "Untitled document",
      body: "",
    };
    setFiles((items) => [...items, file]);
    openFile(file.id);
    setScenario("writing");
    setMode("editor");
  };
  const propose = (event: FormEvent) => {
    event.preventDefault();
    if (!request.trim() || !current.body.trim() || scenario !== "writing")
      return;
    const after = [
      suggestedParagraph,
      ...current.body.split("\n\n").slice(1),
    ].join("\n\n");
    setProposal({ target: current.id, before: current.body, after });
    setNotice("A demo suggestion is ready. Your document has not changed.");
  };
  const approve = () => {
    if (
      !proposal ||
      proposal.target !== activeId ||
      current.body !== proposal.before
    )
      return;
    setBody(proposal.target, proposal.after);
    setApplied(proposal);
    setProposal(null);
    setNotice("Opening updated in this demo. You can undo the change below.");
  };
  const canApprove =
    proposal?.target === current.id && proposal.before === current.body;
  const canUndo =
    applied?.target === current.id && applied.after === current.body;

  return (
    <div className="workspace-page">
      <header className="workspace-heading">
        <div>
          <span className="eyebrow accent">Experience / 03</span>
          <h1>Room for the writing</h1>
          <p>
            Open a document, try an edit, then ask the assistant for a demo
            suggestion.
          </p>
        </div>
        <div className="scenario-control">
          <span className="field-label">Scenario</span>
          <Select
            ariaLabel="Workspace scenario"
            value={scenario}
            options={[
              { value: "writing", label: "Writing & approval" },
              { value: "empty", label: "Empty workspace" },
              { value: "error", label: "Read error" },
            ]}
            onChange={(value) => {
              setScenario(value as Scenario);
              setProposal(null);
              setNotice("");
            }}
          />
        </div>
      </header>
      <div className="canvas-label">
        <span>
          <span className="status-dot" />
          Interactive baseline
        </span>
        <span>Fictional content · Changes reset on reload</span>
      </div>
      <div className="workspace-canvas">
        <div className="manuscript-window">
          <div className="window-titlebar">
            <span className="window-project">
              <FolderOpen size={14} />
              The observation book
            </span>
            <span>Simple AI Writer</span>
            <span className="demo-mark">Local demo</span>
          </div>
          <div
            className={`workspace-grid ${sidebar ? "" : "sidebar-collapsed"}`}
          >
            <nav className="icon-rail" aria-label="Workspace panels">
              <button
                aria-label="Documents panel"
                aria-pressed={panel === "documents" && sidebar}
                onClick={() => {
                  setPanel("documents");
                  setSidebar(true);
                }}
              >
                <FileText size={20} />
              </button>
              <button
                aria-label="Knowledge base panel"
                aria-pressed={panel === "knowledge" && sidebar}
                onClick={() => {
                  setPanel("knowledge");
                  setSidebar(true);
                }}
              >
                <BookOpen size={20} />
              </button>
              <span className="rail-foot">
                <PenMark />
              </span>
            </nav>
            {sidebar && (
              <aside className="document-sidebar">
                <div className="sidebar-heading">
                  <span className="eyebrow">
                    {panel === "documents" ? "Documents" : "Knowledge base"}
                  </span>
                  {panel === "documents" && (
                    <button
                      className="icon-button"
                      aria-label="New document"
                      onClick={newFile}
                    >
                      <Plus size={16} />
                    </button>
                  )}
                </div>
                <label className="sidebar-search">
                  <Search size={13} />
                  <input
                    aria-label={`Search ${panel}`}
                    placeholder="Search…"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                </label>
                {panel === "documents" ? (
                  <>
                    <div className="folder-label">
                      <ChevronDown size={13} />
                      <span>Writing</span>
                      <small>{scenario === "empty" ? 0 : files.length}</small>
                    </div>
                    {scenario !== "empty" &&
                      files
                        .filter((item) =>
                          item.name
                            .toLowerCase()
                            .includes(filter.toLowerCase()),
                        )
                        .map((item) => (
                          <button
                            className="file-button"
                            aria-pressed={activeId === item.id}
                            key={item.id}
                            onClick={() => openFile(item.id)}
                          >
                            <FileText size={13} />
                            <span>{item.name}</span>
                          </button>
                        ))}
                    {scenario !== "empty" &&
                      files.every(
                        (item) =>
                          !item.name
                            .toLowerCase()
                            .includes(filter.toLowerCase()),
                      ) && (
                        <p className="sidebar-empty">No matching documents.</p>
                      )}
                  </>
                ) : (
                  <>
                    {knowledge
                      .map((item, index) => ({ ...item, index }))
                      .filter((item) =>
                        item.title.toLowerCase().includes(filter.toLowerCase()),
                      )
                      .map((item) => (
                        <button
                          className="knowledge-button"
                          aria-pressed={entry === item.index}
                          key={item.title}
                          onClick={() => setEntry(item.index)}
                        >
                          <span>{item.title}</span>
                          <small>{item.type}</small>
                        </button>
                      ))}
                    <div className="entry-summary">
                      <span className="eyebrow">Summary</span>
                      <p>{knowledge[entry].body}</p>
                    </div>
                  </>
                )}
                <div className="sidebar-bottom">
                  {panel === "documents"
                    ? "Documents stay yours."
                    : "Material, within reach."}
                </div>
              </aside>
            )}
            <section className="document-area" aria-label="Document surface">
              <div className="document-toolbar">
                <button
                  className="icon-button"
                  aria-label={sidebar ? "Collapse sidebar" : "Expand sidebar"}
                  onClick={() => setSidebar(!sidebar)}
                >
                  {sidebar ? (
                    <PanelLeftClose size={16} />
                  ) : (
                    <PanelLeftOpen size={16} />
                  )}
                </button>
                <span className="document-name">
                  {scenario === "empty" ? "No document" : current.name}
                </span>
                <div className="view-tabs">
                  {(["editor", "preview", "split"] as Mode[]).map((id) => (
                    <button
                      key={id}
                      aria-pressed={mode === id}
                      onClick={() => setMode(id)}
                    >
                      {id}
                    </button>
                  ))}
                </div>
              </div>
              {scenario === "empty" ? (
                <div className="document-empty">
                  <span className="eyebrow">New document</span>
                  <h2>Begin with a sentence.</h2>
                  <p>A blank page is enough to start.</p>
                  <button className="primary-button" onClick={newFile}>
                    <Plus size={14} />
                    Create a document
                  </button>
                </div>
              ) : scenario === "error" ? (
                <div className="document-empty">
                  <span className="eyebrow">Document unavailable</span>
                  <h2>The page couldn’t open.</h2>
                  <p>Your original file has not been changed.</p>
                  <button
                    className="secondary-button"
                    onClick={() => setScenario("writing")}
                  >
                    <RotateCcw size={14} />
                    Retry demo
                  </button>
                </div>
              ) : (
                <div className={`document-body mode-${mode}`}>
                  {mode !== "preview" && (
                    <div className="editor-surface">
                      <div className="editor-caption">
                        Draft / {current.title}
                      </div>
                      <textarea
                        aria-label="Document editor"
                        value={current.body}
                        placeholder="Write your first sentence…"
                        onChange={(event) =>
                          setBody(current.id, event.target.value)
                        }
                        spellCheck={false}
                      />
                    </div>
                  )}
                  {mode !== "editor" && (
                    <article className="manuscript">
                      <span className="eyebrow">Fieldwork / 01</span>
                      <h2>{current.title}</h2>
                      <div className="manuscript-rule" />
                      {current.body ? (
                        current.body
                          .split("\n\n")
                          .map((paragraph, index) => (
                            <p key={index}>{paragraph}</p>
                          ))
                      ) : (
                        <p className="muted">
                          This page is waiting for its first sentence.
                        </p>
                      )}
                      <span className="manuscript-end">— · —</span>
                    </article>
                  )}
                </div>
              )}
              <div className="document-status">
                <span>
                  {scenario === "empty"
                    ? "No document open"
                    : `${current.body.trim() ? current.body.trim().split(/\s+/).length : 0} words`}
                </span>
                <span>In-memory demo</span>
                <span>{mode}</span>
              </div>
            </section>
            <aside className="assistant-panel" aria-label="Assistant">
              <header>
                <span className="eyebrow">Assistant</span>
                <span className="assistant-model">Demo model</span>
              </header>
              <div className="assistant-conversation" ref={conversationRef}>
                <span className="conversation-number">Conversation / 01</span>
                <h2>
                  A second pair
                  <br />
                  of eyes.
                </h2>
                <p>
                  I can offer a more concise opening while keeping the detail
                  that gives this passage its voice.
                </p>
                <div className="material-reference">
                  <FileText size={13} />
                  <span>{current.name}</span>
                  <small>current</small>
                </div>
                {proposal && (
                  <div className="proposal-card">
                    <span className="eyebrow accent">Review required</span>
                    <h3>Replace the opening</h3>
                    <details className="diff-before">
                      <summary>Before · show original</summary>
                      <p>{proposal.before.split("\n\n")[0]}</p>
                    </details>
                    <div className="diff-after">
                      <small>Suggested</small>
                      <p>{suggestedParagraph}</p>
                    </div>
                    {!canApprove && (
                      <p className="stale-note">
                        The document changed. Request a new suggestion before
                        applying.
                      </p>
                    )}
                    <div className="proposal-actions">
                      <button
                        className="primary-button"
                        disabled={!canApprove}
                        onClick={approve}
                      >
                        <Check size={13} />
                        Approve
                      </button>
                      <button
                        className="text-button"
                        onClick={() => {
                          setProposal(null);
                          setNotice(
                            "Suggestion dismissed. Your document has not changed.",
                          );
                        }}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}
                <p className="assistant-notice" role="status">
                  {notice}
                </p>
                {canUndo && (
                  <button
                    className="text-button"
                    onClick={() => {
                      if (!applied) return;
                      setBody(applied.target, applied.before);
                      setApplied(null);
                      setNotice("Change undone in this demo.");
                    }}
                  >
                    <RotateCcw size={13} />
                    Undo applied change
                  </button>
                )}
              </div>
              <form className="assistant-composer" onSubmit={propose}>
                <div className="composer-context">
                  <span>
                    <Sparkles size={12} />
                    Polish the opening
                  </span>
                </div>
                <textarea
                  aria-label="Message to assistant"
                  value={request}
                  onChange={(event) => setRequest(event.target.value)}
                  placeholder="Ask for a demo suggestion…"
                />
                <div className="composer-footer">
                  <span>Demo · No AI request</span>
                  <button
                    className="icon-button send-button"
                    type="submit"
                    aria-label="Request demo suggestion"
                    disabled={
                      !request.trim() ||
                      !current.body.trim() ||
                      scenario !== "writing"
                    }
                  >
                    <Send size={15} />
                  </button>
                </div>
              </form>
            </aside>
          </div>
        </div>
      </div>
      <div className="review-notes">
        <span className="eyebrow">Try the flow</span>
        <p>
          Edit a sentence → request a suggestion → review → approve or dismiss →
          undo.
          <br />
          Switch the scenario to inspect empty and read-error states. Use Reset
          demo state to start over.
        </p>
      </div>
    </div>
  );
}

function PenMark() {
  return (
    <span className="rail-monogram" aria-hidden="true">
      m.
    </span>
  );
}
