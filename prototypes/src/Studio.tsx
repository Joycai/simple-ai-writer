import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Layers,
  LayoutPanelLeft,
  PenLine,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";
import { applyThemeId } from "../../src/lib/theme/scheme";
import { Select } from "../../src/components/common/Select";
import { Foundations, Components } from "./System";
import { Workspace } from "./Workspace";
import { themes } from "./fixtures";

const pages = [
  { id: "overview", label: "Overview", number: "00", icon: BookOpen },
  { id: "foundations", label: "Foundations", number: "01", icon: Layers },
  {
    id: "components",
    label: "Components",
    number: "02",
    icon: SlidersHorizontal,
  },
  {
    id: "workspace",
    label: "Writing workspace",
    number: "03",
    icon: LayoutPanelLeft,
  },
] as const;
type Page = (typeof pages)[number]["id"];
const initialPage = (): Page => {
  const id = location.hash.slice(1);
  return pages.find((page) => page.id === id)?.id ?? "overview";
};

export function Studio() {
  const [page, setPage] = useState<Page>(initialPage);
  const [theme, setTheme] = useState("paper");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const sync = () => setPage(initialPage());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  useEffect(() => {
    document.getElementById("studio-content")?.scrollTo(0, 0);
  }, [page]);
  const active = pages.find((item) => item.id === page)!;
  const chooseTheme = (id: string) => {
    const next = themes.find((item) => item.value === id);
    if (!next) return;
    applyThemeId(next.value, next.scheme);
    setTheme(next.value);
  };

  return (
    <div className="studio">
      <a
        className="skip-link"
        href="#studio-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("studio-content")?.focus();
        }}
      >
        Skip to content
      </a>
      <aside className="studio-nav" aria-label="Design studio navigation">
        <a className="studio-brand" href="#overview">
          <PenLine size={22} />
          <span>
            Manuscript<small>Simple AI Writer</small>
          </span>
        </a>
        <div className="nav-caption eyebrow">Design studio / 01</div>
        <nav>
          {pages.map(({ id, label, number, icon: Icon }) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={page === id ? "page" : undefined}
            >
              <Icon size={17} />
              <span>{label}</span>
              <small>{number}</small>
            </a>
          ))}
        </nav>
        <div className="nav-foot">
          <span className="status-dot" />
          Local prototype library
          <p>
            A shared language.
            <br />
            Room for the work.
          </p>
        </div>
      </aside>
      <div className="studio-main">
        <header className="studio-bar">
          <div>
            <span className="eyebrow">Design library</span>
            <span className="bar-divider">/</span>
            {active.label}
          </div>
          <div className="bar-actions">
            <span className="muted">Appearance</span>
            <Select
              ariaLabel="Studio theme"
              value={theme}
              options={themes.map(({ value, label }) => ({ value, label }))}
              onChange={chooseTheme}
            />
            <span className="demo-mark">Prototype</span>
          </div>
        </header>
        <main
          id="studio-content"
          tabIndex={-1}
          className={
            page === "workspace"
              ? "studio-content workspace-content"
              : "studio-content"
          }
        >
          {page === "overview" && <Overview />}
          {page === "foundations" && (
            <Foundations key={revision} theme={theme} />
          )}
          {page === "components" && <Components key={revision} />}
          {page === "workspace" && <Workspace key={revision} />}
        </main>
        <footer className="studio-footer">
          <span>
            Simple AI Writer <span className="footer-slash">/</span> Design
            before implementation
          </span>
          <button
            className="text-button"
            onClick={() => setRevision((value) => value + 1)}
          >
            <RotateCcw size={13} />
            Reset demo state
          </button>
        </footer>
      </div>
    </div>
  );
}

function Overview() {
  return (
    <div className="overview">
      <div className="eyebrow accent">A working design reference</div>
      <h1>
        A quieter place
        <br />
        to make things.
      </h1>
      <p className="lead">
        The language of Simple AI Writer, made tangible.
        <br />
        Explore the foundations. Try the controls. Follow a writing flow.
      </p>
      <div className="overview-rule">
        <span>Manuscript / system & experience</span>
        <span>Edition 01</span>
      </div>
      <div className="chapter-links">
        {[
          {
            id: "foundations",
            n: "01",
            title: "The foundations",
            description:
              "Six appearances. One token system. Type, space, and the meaning of a line.",
          },
          {
            id: "components",
            n: "02",
            title: "The small decisions",
            description:
              "Buttons, fields, selections, and states. Real controls you can use.",
          },
          {
            id: "workspace",
            n: "03",
            title: "Room for the writing",
            description:
              "A document, its material, and an assistant. Review a change before it reaches the page.",
          },
        ].map((item) => (
          <a href={`#${item.id}`} key={item.id}>
            <span className="chapter-number">{item.n}</span>
            <div>
              <h2>{item.title}</h2>
              <p>{item.description}</p>
            </div>
            <ArrowUpRight size={21} />
          </a>
        ))}
      </div>
      <div className="principle-note">
        <span className="eyebrow">The governing idea</span>
        <p>
          Paper carries the work. Geometry carries selection.
          <br />
          Accent carries the decision that matters.
        </p>
        <small>
          Built from the app’s existing design system. All interactions use
          fictional, in-memory data.
        </small>
      </div>
    </div>
  );
}
