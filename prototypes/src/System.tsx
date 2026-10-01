import { useEffect, useState } from "react";
import { ArrowRight, Check, Search } from "lucide-react";
import { TOKEN_CONTRACT } from "../../src/lib/theme/contractData";
import { Select } from "../../src/components/common/Select";
import { Slider } from "../../src/components/common/Slider";

const palette = [
  ["--color-bg-base", "Ground"],
  ["--color-bg-surface", "Surface"],
  ["--color-bg-elevated", "Raised surface"],
  ["--color-text-primary", "Primary ink"],
  ["--color-text-muted", "Quiet ink"],
  ["--color-accent", "Decision"],
  ["--color-success", "Success"],
  ["--color-warning", "Warning"],
  ["--color-error", "Error"],
] as const;
const groups = {
  core: TOKEN_CONTRACT.core,
  scale: TOKEN_CONTRACT.scale,
  derived: TOKEN_CONTRACT.derived,
};
type TokenGroup = keyof typeof groups;

export function Foundations({ theme }: { theme: string }) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<TokenGroup>("core");
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    const computed = getComputedStyle(document.documentElement);
    setValues(
      Object.fromEntries(
        Object.values(groups)
          .flat()
          .map((name) => [name, computed.getPropertyValue(name).trim()]),
      ),
    );
  }, [theme]);
  const shown = groups[group].filter((name) =>
    name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="system-page">
      <PageHeading
        number="01"
        title="The foundations"
        description="A living reference, drawn from the same tokens as the application."
      />
      <section className="system-section">
        <SectionHeading
          number="01.1"
          title="Colour has a job"
          description="A quiet ground. Five tiers of ink. One accent for the decision."
        />
        <div className="swatch-grid">
          {palette.map(([name, label]) => (
            <div className="swatch" key={name}>
              <div
                className="swatch-colour"
                style={{ background: `var(${name})` }}
              />
              <strong>{label}</strong>
              <code>{name}</code>
            </div>
          ))}
        </div>
      </section>
      <section className="system-section">
        <SectionHeading
          number="01.2"
          title="Three voices"
          description="Serif for the work, sans for the wayfinding, mono for exact information."
        />
        <div className="type-specimens">
          <div>
            <span className="eyebrow">The manuscript / serif</span>
            <p className="serif-specimen">
              Make room for
              <br />a good sentence.
            </p>
            <code>--font-serif · --font-size-2xl</code>
          </div>
          <div>
            <span className="eyebrow">The interface / sans</span>
            <p className="sans-specimen">A clear next step.</p>
            <span className="type-description">
              Search documents · Open an entry · Review a change
            </span>
            <code>--font-sans · --font-size-base</code>
          </div>
          <div>
            <span className="eyebrow">The exact / mono</span>
            <p className="mono-specimen">
              128,000
              <br />
              03 / 12
              <br />
              draft.md
            </p>
            <code>--font-mono</code>
          </div>
        </div>
      </section>
      <section className="system-section">
        <SectionHeading
          number="01.3"
          title="Space, not decoration"
          description="Square corners, measured spacing, and hairlines that establish hierarchy."
        />
        <div className="spacing-ramp">
          {TOKEN_CONTRACT.scale
            .filter((name) => name.startsWith("--space-"))
            .map((name) => (
              <div key={name}>
                <div
                  className="spacing-bar"
                  style={{ width: `var(${name})` }}
                />
                <code>{name}</code>
                <span>{values[name]}</span>
              </div>
            ))}
        </div>
      </section>
      <section className="system-section">
        <SectionHeading
          number="01.4"
          title="Inspect the source language"
          description="Names come from the app’s token contract; values reflect the selected appearance."
        />
        <div className="token-toolbar">
          <div className="segmented" aria-label="Token group">
            {(Object.keys(groups) as TokenGroup[]).map((id) => (
              <button
                key={id}
                aria-pressed={group === id}
                onClick={() => setGroup(id)}
              >
                {id}
                <small>{groups[id].length}</small>
              </button>
            ))}
          </div>
          <label className="search-field">
            <Search size={15} />
            <input
              aria-label="Search tokens"
              placeholder="Find a token…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        <div className="token-table-wrap">
          <table className="token-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Current value</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((name) => (
                <tr key={name}>
                  <td>
                    <code>{name}</code>
                  </td>
                  <td>
                    <code>{values[name] || "—"}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && (
            <p className="empty-inline" role="status">
              No tokens match “{query}”.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

export function Components() {
  const [name, setName] = useState("");
  const [model, setModel] = useState("balanced");
  const [enabled, setEnabled] = useState(false);
  const [budget, setBudget] = useState(128);
  const [selected, setSelected] = useState("notes");
  const [approved, setApproved] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <div className="system-page">
      <PageHeading
        number="02"
        title="The small decisions"
        description="Interactive specimens. Use Tab to inspect focus and the arrow keys to move through controls."
      />
      <section className="system-section">
        <SectionHeading
          number="02.1"
          title="Actions, in order"
          description="One primary decision. Everything else has a quieter voice."
        />
        <div className="specimen-row">
          <button
            className="primary-button"
            onClick={() => setMessage("Primary action selected.")}
          >
            Continue
            <ArrowRight size={14} />
          </button>
          <button
            className="secondary-button"
            onClick={() => setMessage("Secondary action selected.")}
          >
            Save draft
          </button>
          <button
            className="text-button"
            onClick={() => setMessage("Cancelled.")}
          >
            Cancel
          </button>
          <button className="primary-button" disabled>
            Unavailable
          </button>
        </div>
        <p className="inline-feedback" role="status">
          {message || "Choose an action to see its local feedback."}
        </p>
      </section>
      <section className="system-section">
        <SectionHeading
          number="02.2"
          title="Inputs that say what they mean"
          description="Unset is distinct from zero. A switch’s shape stays square."
        />
        <div className="control-grid">
          <label className="field-label">
            Document name
            <input
              className="text-input"
              placeholder="Untitled document"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <small>
              {name
                ? `Ready to name “${name}”.`
                : "Empty: no name has been chosen."}
            </small>
          </label>
          <div className="field-label">
            Model profile
            <Select
              ariaLabel="Model profile"
              value={model}
              options={[
                { value: "balanced", label: "Balanced" },
                { value: "careful", label: "Careful" },
                { value: "fast", label: "Fast" },
              ]}
              onChange={setModel}
            />
            <small>The app’s shared Select control.</small>
          </div>
          <div className="field-label">
            Sampling value
            <input
              className="text-input unset-input"
              placeholder="Not sent"
              aria-label="Sampling value"
              type="number"
              min="0"
              max="2"
              step="0.1"
            />
            <small>Blank means unset; 0 is a value.</small>
          </div>
          <div className="switch-row">
            <div>
              <strong>Use material automatically</strong>
              <small>Local specimen state only.</small>
            </div>
            <button
              role="switch"
              aria-checked={enabled}
              aria-label="Use material automatically"
              className="square-switch"
              onClick={() => setEnabled(!enabled)}
            >
              <span />
            </button>
          </div>
        </div>
        <div className="slider-specimen">
          <div className="section-line">
            <span>Context budget</span>
            <code>{budget}k tokens</code>
          </div>
          <Slider
            value={budget}
            min={8}
            max={512}
            step={8}
            scale="log2"
            snapToTicks
            ticks={[
              { value: 8, label: "8k" },
              { value: 32, label: "32k" },
              { value: 128, label: "128k" },
              { value: 512, label: "512k" },
            ]}
            onChange={setBudget}
            ariaLabel="Context budget"
            valueText={`${budget} thousand tokens`}
          />
          <small>
            The app’s shared Slider, including keyboard control and logarithmic
            ticks.
          </small>
        </div>
      </section>
      <section className="system-section">
        <SectionHeading
          number="02.3"
          title="Hover is not selection"
          description="Hover uses a neutral ground. A selected row carries accent and a clear edge."
        />
        <div className="list-specimen">
          {[
            { id: "notes", name: "Field notes.md", status: "Current document" },
            { id: "outline", name: "Working outline.md", status: "Draft" },
            { id: "research", name: "Research notes.md", status: "Material" },
          ].map((item) => (
            <button
              className="document-row"
              aria-pressed={selected === item.id}
              key={item.id}
              onClick={() => setSelected(item.id)}
            >
              <span>{item.name}</span>
              <small>{item.status}</small>
            </button>
          ))}
        </div>
      </section>
      <section className="system-section">
        <SectionHeading
          number="02.4"
          title="A protected change waits"
          description="The proposal is the decision surface. Applying it is always explicit."
        />
        <div className="approval-specimen">
          <span className="eyebrow accent">
            {approved ? "Approved locally" : "Review required"}
          </span>
          <h3>Replace the opening paragraph</h3>
          <p>
            The assistant proposes a tighter opening. Review the changed passage
            before applying it.
          </p>
          <div className="specimen-row">
            <button
              className="primary-button"
              disabled={approved}
              onClick={() => setApproved(true)}
            >
              <Check size={14} />
              {approved ? "Applied in this demo" : "Approve change"}
            </button>
            <button className="text-button" onClick={() => setApproved(false)}>
              Reset proposal
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function PageHeading({
  number,
  title,
  description,
}: {
  number: string;
  title: string;
  description: string;
}) {
  return (
    <header className="page-heading">
      <span className="eyebrow accent">Manuscript / {number}</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  );
}
function SectionHeading({
  number,
  title,
  description,
}: {
  number: string;
  title: string;
  description: string;
}) {
  return (
    <div className="section-heading">
      <code>{number}</code>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  );
}
