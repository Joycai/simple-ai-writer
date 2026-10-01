// Fictional review data. No project files or configured providers are read.
export const documents = [
  {
    id: "field-notes",
    name: "Field notes.md",
    title: "The things we notice",
    body: "At the edge of the old station, the light changes before the weather does. A narrow line of gold moves across the floor, finding the dust in the air.\n\nWe came here to write down the things that usually pass unnoticed: a door held open, a familiar voice, the small quiet between one train and the next.\n\nA good document begins with attention. The rest is a matter of making room for it.",
  },
  {
    id: "outline",
    name: "Working outline.md",
    title: "A place to begin",
    body: "Start with a place, then a detail. Let the reader arrive before explaining why they are here.\n\nCollect observations in the knowledge base. Return to the document when the shape of the story becomes clear.",
  },
  {
    id: "research",
    name: "Research notes.md",
    title: "What we know",
    body: "The station opened in spring. Its windows face east, and the waiting room has kept the same wooden benches for years.\n\nThese are fictional notes for an interactive prototype. They are not material from an author's project.",
  },
];

export const suggestedParagraph =
  "At the edge of the old station, morning arrives in a thin line of gold. It travels across the floor, catching the dust before it reaches the door.";

export const themes = [
  { value: "paper", label: "Paper", scheme: "light" },
  { value: "night", label: "Night", scheme: "dark" },
  { value: "stone", label: "Stone", scheme: "light" },
  { value: "ink", label: "Ink", scheme: "dark" },
  { value: "frost", label: "Frost", scheme: "light" },
  { value: "indigo", label: "Indigo", scheme: "dark" },
] as const;
