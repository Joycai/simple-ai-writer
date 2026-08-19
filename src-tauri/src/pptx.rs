//! .pptx → Markdown, in Rust, and readable **one range of slides at a time**.
//!
//! Sibling of `xlsx.rs` and for the same reason: a .pptx is a zip of XML, so
//! the bytes mean nothing to a model, and the parser belongs where the zip
//! reader already is — `zip` is a direct dependency (lore bundles) and
//! `quick-xml` was already in the tree under calamine. Nothing new ships to
//! make this work.
//!
//! Two things make this module different from the xlsx one:
//!
//! - **It pages.** A deck of three hundred slides must not arrive as one
//!   string: `pptx_read_slides` renders whole slides until a character budget
//!   is spent and reports where to resume, which is the protocol `read_file`
//!   already uses for long chapters (lib/agent/tools.ts). Only the slides in
//!   the requested range are parsed — the slide order comes from
//!   `presentation.xml`, and a zip entry is fetched by name — so paging through
//!   a deck costs one slide's work per call, not the whole deck's.
//! - **Slide order is not file order.** `ppt/slides/slide10.xml` sorts before
//!   `slide2.xml`, and neither name is authoritative anyway: the running order
//!   is `<p:sldIdLst>` in `presentation.xml`, resolved through the
//!   relationship ids. Reading the folder would silently reorder the deck.
//!
//! Legacy `.ppt` (PowerPoint 97-2003) is deliberately out of scope: it is an
//! OLE compound binary, not a zip, and no crate here can read it. Same call as
//! `.doc`/`.xls` in the importer — a half-garbled import looks exactly like a
//! successful one.

use crate::scope::FsScope;
use crate::xlsx::escape_cell;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use quick_xml::escape::unescape;
use quick_xml::events::attributes::Attribute;
use quick_xml::events::{BytesRef, Event};
use quick_xml::Reader;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Cursor, Read};
use tauri::{command, State};
use zip::ZipArchive;

/// Slides rendered by one call, whatever the character budget says. Guards the
/// pathological deck (a generated report with thousands of near-empty slides)
/// from turning one tool call into a minute of parsing.
const MAX_SLIDES_PER_CALL: usize = 500;

/// Characters kept from one slide. A slide is a *page*: text past this point is
/// a pasted document, not a slide, and letting one such shape eat a whole
/// paging budget would stall the reader on a single page.
const MAX_CHARS_PER_SLIDE: usize = 4000;

/// Budget for a whole-file conversion (the importer). Not `usize::MAX` — the
/// result is a markdown file a person has to open.
const MAX_IMPORT_CHARS: usize = 4_000_000;

/// Budget one paged read may ask for. The caller is our own tool wrapper, not
/// the model, but the clamp keeps a future caller from asking for the deck.
const MAX_READ_CHARS: usize = 20_000;

/// One range of slides, rendered.
#[derive(Debug, Serialize)]
pub struct SlideRange {
    pub markdown: String,
    pub total_slides: usize,
    pub from_slide: usize,
    pub to_slide: usize,
    /// Where a follow-up call should start, or None at the end of the deck.
    pub next_slide: Option<usize>,
}

type Zip = ZipArchive<Cursor<Vec<u8>>>;

/// One zip entry as text, or None when it is absent or not UTF-8.
///
/// Absence is routine rather than exceptional here — a slide with no pictures
/// has no `_rels` file, a deck with no speaker notes has no notes parts — so
/// the caller reads the Option as "nothing to add", not as a failure.
fn read_entry(zip: &mut Zip, name: &str) -> Option<String> {
    let mut file = zip.by_name(name).ok()?;
    let mut out = String::new();
    file.read_to_string(&mut out).ok()?;
    Some(out)
}

/// Resolve a relationship target against the part that declared it.
///
/// Targets are relative to the *folder of the declaring part*
/// (`../notesSlides/notesSlide1.xml` from `ppt/slides/`), except when they are
/// absolute (`/ppt/media/image1.png`). Zip entry names have no `.`/`..` to
/// resolve, so the join has to do it here or `by_name` finds nothing.
fn join_target(base_dir: &str, target: &str) -> String {
    if let Some(rest) = target.strip_prefix('/') {
        return rest.to_string();
    }
    let mut parts: Vec<&str> = base_dir.split('/').filter(|p| !p.is_empty()).collect();
    for segment in target.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// The folder a part lives in: "ppt/slides/slide1.xml" → "ppt/slides".
fn dir_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(at) => &path[..at],
        None => "",
    }
}

/// The `_rels` part that belongs to a part: "ppt/slides/slide1.xml" →
/// "ppt/slides/_rels/slide1.xml.rels".
fn rels_path(part: &str) -> String {
    let dir = dir_of(part);
    let name = &part[if dir.is_empty() { 0 } else { dir.len() + 1 }..];
    if dir.is_empty() {
        format!("_rels/{name}.rels")
    } else {
        format!("{dir}/_rels/{name}.rels")
    }
}

/// One attribute's value as text.
///
/// Not quick-xml's own `unescape_value`: that method is gated on the `encoding`
/// feature being **off**, and calamine turns it on for the whole build, so it
/// does not exist here. The parts are XML and therefore UTF-8 by definition,
/// and `escape::unescape` resolves the predefined entities — which is the whole
/// of what the gated method added.
fn attr_text(attr: &Attribute) -> String {
    let raw = String::from_utf8_lossy(&attr.value);
    match unescape(&raw) {
        Ok(v) => v.into_owned(),
        Err(_) => raw.into_owned(),
    }
}

/// The text an `&…;` reference stands for.
///
/// quick-xml 0.41 reports references as their own event rather than folding
/// them into the surrounding text, so a title containing `&` arrives in three
/// pieces and this is the middle one. Anything unresolvable (a DTD-defined
/// entity, which OOXML does not use) contributes nothing rather than leaking
/// `&amp;` into the markdown.
fn reference_text(r: &BytesRef) -> Option<String> {
    if let Ok(Some(ch)) = r.resolve_char_ref() {
        return Some(ch.to_string());
    }
    let name = r.decode().ok()?;
    match name.as_ref() {
        "amp" => Some("&".into()),
        "lt" => Some("<".into()),
        "gt" => Some(">".into()),
        "quot" => Some("\"".into()),
        "apos" => Some("'".into()),
        _ => None,
    }
}

/// `Id` → `Target` from a `.rels` part. Unreadable or absent rels yield an
/// empty map: a slide whose relationships we cannot read still has its text.
fn parse_rels(xml: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                if e.local_name().as_ref() != b"Relationship" {
                    continue;
                }
                let mut id = None;
                let mut target = None;
                for attr in e.attributes().flatten() {
                    match attr.key.local_name().as_ref() {
                        b"Id" => id = Some(attr_text(&attr)),
                        b"Target" => target = Some(attr_text(&attr)),
                        _ => {}
                    }
                }
                if let (Some(id), Some(target)) = (id, target) {
                    out.insert(id, target);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

/// The deck's slide parts, in running order.
///
/// `<p:sldId r:id="rId2"/>` carries both an `id` (a deck-internal number) and
/// an `r:id` (the relationship). Attributes are matched on local name plus the
/// presence of a prefix rather than the literal string "r:id", because the
/// relationship namespace prefix is a document's own choice.
fn slide_parts(zip: &mut Zip) -> Result<Vec<String>, String> {
    let rels_xml = read_entry(zip, "ppt/_rels/presentation.xml.rels").ok_or_else(|| {
        "Not a readable .pptx file: no ppt/_rels/presentation.xml.rels".to_string()
    })?;
    let rels = parse_rels(&rels_xml);
    let pres = read_entry(zip, "ppt/presentation.xml")
        .ok_or_else(|| "Not a readable .pptx file: no ppt/presentation.xml".to_string())?;

    let mut out = Vec::new();
    let mut in_list = false;
    let mut reader = Reader::from_str(&pres);
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if e.local_name().as_ref() == b"sldIdLst" => in_list = true,
            Ok(Event::End(e)) if e.local_name().as_ref() == b"sldIdLst" => break,
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                if !in_list || e.local_name().as_ref() != b"sldId" {
                    continue;
                }
                for attr in e.attributes().flatten() {
                    let key = attr.key.as_ref();
                    if attr.key.local_name().as_ref() == b"id" && key.contains(&b':') {
                        if let Some(target) = rels.get(attr_text(&attr).as_str()) {
                            out.push(join_target("ppt", target));
                        }
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    Ok(out)
}

/// A piece of a slide, in the order the slide's XML declares it.
enum Block {
    /// Text of a title placeholder.
    Title(String),
    /// One `<a:p>`, with its outline level.
    Para {
        lvl: usize,
        text: String,
    },
    Table(Vec<Vec<String>>),
    /// File name of an embedded picture (the bytes stay in the zip).
    Image(String),
}

/// Extract one slide's blocks.
///
/// A single streaming pass with a handful of flags rather than a DOM: the
/// nesting that matters is shallow (shape → text body → paragraph → run) and
/// the only cross-cutting state is "which shape am I in".
///
/// Element names are matched on their *local* name so a deck that declares the
/// DrawingML/PresentationML namespaces under different prefixes still parses.
/// The local names in play (`sp`, `ph`, `p`, `t`, `tbl`, `pic`, `blip`) do not
/// collide across those two namespaces.
fn parse_slide(xml: &str, rels: &HashMap<String, String>, base_dir: &str) -> Vec<Block> {
    let mut blocks = Vec::new();

    let mut is_title_shape = false;
    let mut in_pic = false;
    let mut in_text = false;

    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell: Option<String> = None;
    let mut in_table = false;

    let mut para: Option<String> = None;
    let mut lvl = 0usize;

    let mut reader = Reader::from_str(xml);
    // Ends on the first parse error rather than propagating it: a malformed
    // tail must not lose the slide's earlier text.
    while let Ok(event) = reader.read_event() {
        match event {
            Event::Start(e) | Event::Empty(e) => {
                match e.local_name().as_ref() {
                    b"sp" => {
                        is_title_shape = false;
                    }
                    b"pic" => in_pic = true,
                    b"ph" => {
                        for attr in e.attributes().flatten() {
                            if attr.key.local_name().as_ref() == b"type" {
                                let v = attr_text(&attr);
                                is_title_shape = v == "title" || v == "ctrTitle";
                            }
                        }
                    }
                    b"blip" if in_pic => {
                        for attr in e.attributes().flatten() {
                            if attr.key.local_name().as_ref() == b"embed" {
                                if let Some(target) = rels.get(attr_text(&attr).as_str()) {
                                    let name = join_target(base_dir, target);
                                    let file = name.rsplit('/').next().unwrap_or(&name).to_string();
                                    blocks.push(Block::Image(file));
                                }
                            }
                        }
                    }
                    b"tbl" => {
                        in_table = true;
                        rows.clear();
                    }
                    b"tr" if in_table => row.clear(),
                    b"tc" if in_table => cell = Some(String::new()),
                    b"p" => {
                        para = Some(String::new());
                        lvl = 0;
                    }
                    b"pPr" => {
                        for attr in e.attributes().flatten() {
                            if attr.key.local_name().as_ref() == b"lvl" {
                                lvl = attr_text(&attr).parse::<usize>().unwrap_or(0);
                            }
                        }
                    }
                    b"t" => in_text = true,
                    // A soft line break inside a paragraph: a space, not a
                    // newline — a newline would break the markdown list item
                    // the paragraph becomes.
                    b"br" => {
                        if let Some(buf) = para.as_mut() {
                            buf.push(' ');
                        }
                    }
                    _ => {}
                }
            }
            Event::Text(t) => {
                if in_text {
                    if let Some(buf) = para.as_mut() {
                        buf.push_str(&t.decode().unwrap_or_default());
                    }
                }
            }
            Event::GeneralRef(r) => {
                if in_text {
                    if let (Some(buf), Some(text)) = (para.as_mut(), reference_text(&r)) {
                        buf.push_str(&text);
                    }
                }
            }
            Event::End(e) => match e.local_name().as_ref() {
                b"t" => in_text = false,
                b"sp" => is_title_shape = false,
                b"pic" => in_pic = false,
                b"p" => {
                    let text = para.take().unwrap_or_default();
                    let trimmed = text.trim().to_string();
                    if let Some(buf) = cell.as_mut() {
                        if !trimmed.is_empty() {
                            if !buf.is_empty() {
                                buf.push(' ');
                            }
                            buf.push_str(&trimmed);
                        }
                    } else if !trimmed.is_empty() {
                        if is_title_shape {
                            blocks.push(Block::Title(trimmed));
                        } else {
                            blocks.push(Block::Para { lvl, text: trimmed });
                        }
                    }
                }
                b"tc" => {
                    if let Some(text) = cell.take() {
                        row.push(text);
                    }
                }
                b"tr" => rows.push(std::mem::take(&mut row)),
                b"tbl" => {
                    in_table = false;
                    if !rows.is_empty() {
                        blocks.push(Block::Table(std::mem::take(&mut rows)));
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    blocks
}

/// A slide's speaker notes as one string, or empty when there are none.
///
/// The notes part repeats the slide's own text in a thumbnail placeholder, so
/// only the body placeholder's paragraphs are kept — everything else there is
/// a copy of what the slide already said.
fn parse_notes(xml: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut in_body_shape = false;
    let mut in_text = false;
    let mut para: Option<String> = None;

    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                b"sp" => in_body_shape = false,
                b"ph" => {
                    for attr in e.attributes().flatten() {
                        if attr.key.local_name().as_ref() == b"type" {
                            in_body_shape = attr_text(&attr) == "body";
                        }
                    }
                }
                b"p" => para = Some(String::new()),
                b"t" => in_text = true,
                b"br" => {
                    if let Some(buf) = para.as_mut() {
                        buf.push(' ');
                    }
                }
                _ => {}
            },
            Ok(Event::Text(t)) => {
                if in_text {
                    if let Some(buf) = para.as_mut() {
                        buf.push_str(&t.decode().unwrap_or_default());
                    }
                }
            }
            Ok(Event::GeneralRef(r)) => {
                if in_text {
                    if let (Some(buf), Some(text)) = (para.as_mut(), reference_text(&r)) {
                        buf.push_str(&text);
                    }
                }
            }
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"t" => in_text = false,
                b"sp" => in_body_shape = false,
                b"p" => {
                    let text = para.take().unwrap_or_default().trim().to_string();
                    if in_body_shape && !text.is_empty() {
                        lines.push(text);
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    lines.join(" ")
}

/// Assemble a markdown table from a slide table's already-collected cells.
/// Mirrors the xlsx converter: first row as the header, short rows padded.
fn render_table(rows: &[Vec<String>]) -> String {
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    if width == 0 {
        return String::new();
    }
    let line = |cells: &[String]| -> String {
        let mut padded: Vec<String> = cells.iter().map(|c| escape_cell(c)).collect();
        padded.resize(width, String::new());
        format!("| {} |", padded.join(" | "))
    };
    let mut out = vec![
        line(&rows[0]),
        format!("| {} |", vec!["---"; width].join(" | ")),
    ];
    out.extend(rows[1..].iter().map(|r| line(r)));
    out.join("\n")
}

/// One slide as a markdown section.
///
/// The `<!-- slide N -->` marker matches the `<!-- page N -->` the PDF importer
/// writes: invisible in the preview, but it gives an answer somewhere to cite,
/// and it survives into RAG context.
///
/// Body paragraphs become list items indented by outline level. Slide bodies
/// are overwhelmingly bulleted and the hierarchy is the part worth keeping; a
/// stray prose text box reading as one bullet is the cheaper mistake.
fn render_slide(number: usize, blocks: Vec<Block>, notes: &str) -> String {
    let mut title: Option<String> = None;
    let mut body: Vec<String> = Vec::new();

    for block in blocks {
        match block {
            Block::Title(text) => {
                if title.is_none() {
                    title = Some(text);
                } else {
                    body.push(format!("**{text}**"));
                }
            }
            Block::Para { lvl, text } => {
                let indent = "  ".repeat(lvl.min(8));
                body.push(format!("{indent}- {text}"));
            }
            Block::Table(rows) => {
                let table = render_table(&rows);
                if !table.is_empty() {
                    body.push(table);
                }
            }
            Block::Image(name) => body.push(format!("_[image: {name}]_")),
        }
    }

    let heading = match title {
        Some(t) => format!("## Slide {number} · {t}"),
        None => format!("## Slide {number}"),
    };

    let mut parts = vec![format!("<!-- slide {number} -->"), heading];
    if body.is_empty() {
        parts.push("_(no text on this slide)_".to_string());
    } else {
        parts.push(body.join("\n"));
    }
    if !notes.is_empty() {
        parts.push(format!("> **Notes:** {notes}"));
    }

    let mut out = parts.join("\n\n");
    if out.chars().count() > MAX_CHARS_PER_SLIDE {
        out = out.chars().take(MAX_CHARS_PER_SLIDE).collect();
        out.push_str(&format!(
            "\n\n_[... slide {number} truncated at {MAX_CHARS_PER_SLIDE} characters ...]_"
        ));
    }
    out
}

/// Render one slide part, notes and all.
fn slide_markdown(zip: &mut Zip, part: &str, number: usize) -> String {
    let Some(xml) = read_entry(zip, part) else {
        return format!("<!-- slide {number} -->\n\n## Slide {number}\n\n_(could not be read)_");
    };
    let rels = read_entry(zip, &rels_path(part))
        .map(|x| parse_rels(&x))
        .unwrap_or_default();
    let base_dir = dir_of(part).to_string();

    let notes_part = rels
        .values()
        .find(|t| t.contains("notesSlide"))
        .map(|t| join_target(&base_dir, t));
    let notes = notes_part
        .and_then(|p| read_entry(zip, &p))
        .map(|x| parse_notes(&x))
        .unwrap_or_default();

    let blocks = parse_slide(&xml, &rels, &base_dir);
    render_slide(number, blocks, &notes)
}

/// Render slides `from_slide..` until `max_chars` is spent.
///
/// The first slide of a range is always taken, however long it is — the same
/// rule `read_file` applies to a line, and for the same reason: a budget that
/// can return nothing at all leaves the caller with no way forward.
fn convert_range(data: Vec<u8>, from_slide: usize, max_chars: usize) -> Result<SlideRange, String> {
    let mut zip = ZipArchive::new(Cursor::new(data))
        .map_err(|e| format!("Not a readable .pptx file: {e}"))?;
    let parts = slide_parts(&mut zip)?;
    let total = parts.len();

    if total == 0 {
        return Ok(SlideRange {
            markdown: "_(this presentation has no slides)_".to_string(),
            total_slides: 0,
            from_slide: 0,
            to_slide: 0,
            next_slide: None,
        });
    }

    let from = from_slide.max(1);
    if from > total {
        return Err(format!(
            "start_slide {from} is past the end of the presentation, which has {total} slide(s)."
        ));
    }

    let mut sections: Vec<String> = Vec::new();
    let mut chars = 0usize;
    let mut to = from - 1;
    for (offset, part) in parts.iter().enumerate().skip(from - 1) {
        let number = offset + 1;
        let section = slide_markdown(&mut zip, part, number);
        let cost = section.chars().count() + 2; // the blank line joining sections
        if !sections.is_empty()
            && (chars + cost > max_chars || sections.len() >= MAX_SLIDES_PER_CALL)
        {
            break;
        }
        chars += cost;
        to = number;
        sections.push(section);
    }

    Ok(SlideRange {
        markdown: sections.join("\n\n"),
        total_slides: total,
        from_slide: from,
        to_slide: to,
        next_slide: if to < total { Some(to + 1) } else { None },
    })
}

/// Convert a whole .pptx to Markdown, for the importer.
///
/// Bytes arrive base64-encoded rather than as a JSON array of numbers (the
/// shape `xlsx_to_markdown` takes): Tauri's IPC is JSON either way, but the
/// array form inflates a file roughly fourfold on the UI thread, and a deck
/// full of pictures is exactly the file where that hurts. Same encoding as
/// `fs_write_binary_file`.
#[command]
pub fn pptx_to_markdown(data: String) -> Result<String, String> {
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("not valid base64: {e}"))?;
    let range = convert_range(bytes, 1, MAX_IMPORT_CHARS)?;
    let mut out = range.markdown;
    // Truncation is always announced — a silently short import reads exactly
    // like a short presentation.
    if let Some(next) = range.next_slide {
        out.push_str(&format!(
            "\n\n_[... {} more slide(s) not converted — the presentation has {} ...]_",
            range.total_slides - next + 1,
            range.total_slides
        ));
    }
    Ok(out)
}

/// Read one range of slides from a .pptx **inside the project**.
///
/// Takes a path rather than bytes, unlike the importer above: this file is
/// already in the workspace, so `FsScope` can vouch for it, and handing the
/// whole deck across IPC just to page through it would defeat the paging. The
/// scope check is the same one every `fs_*` command runs (see scope.rs).
#[command]
pub fn pptx_read_slides(
    path: String,
    start_slide: Option<usize>,
    max_chars: Option<usize>,
    scope: State<'_, FsScope>,
) -> Result<SlideRange, String> {
    scope.check(&path)?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let budget = max_chars.unwrap_or(4000).clamp(500, MAX_READ_CHARS);
    convert_range(bytes, start_slide.unwrap_or(1), budget)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    // ─── Fixture ────────────────────────────────────────────────────────────
    //
    // Built here rather than checked in as a binary: a .pptx fixture in the
    // repo would make every expectation below unreadable, and the parts that
    // matter (slide order via sldIdLst, placeholder types, outline levels) are
    // exactly the ones an opaque fixture would hide.

    fn shape(ph: Option<&str>, paras: &[(u32, &str)]) -> String {
        let ph_xml = match ph {
            Some(t) => format!(r#"<p:nvSpPr><p:nvPr><p:ph type="{t}"/></p:nvPr></p:nvSpPr>"#),
            None => "<p:nvSpPr><p:nvPr/></p:nvSpPr>".to_string(),
        };
        let body: String = paras
            .iter()
            .map(|(lvl, text)| {
                format!(r#"<a:p><a:pPr lvl="{lvl}"/><a:r><a:t>{text}</a:t></a:r></a:p>"#)
            })
            .collect();
        format!("<p:sp>{ph_xml}<p:txBody>{body}</p:txBody></p:sp>")
    }

    fn slide_xml(shapes: &str) -> String {
        format!(
            r#"<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>{shapes}</p:spTree></p:cSld></p:sld>"#
        )
    }

    /// A deck whose slide *parts* are deliberately numbered against their
    /// running order, so a converter that sorts by file name fails loudly.
    fn deck(slides: Vec<(String, Option<String>)>) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default();
        let mut ids = String::new();
        let mut rels = String::new();

        for (i, (xml, notes)) in slides.iter().enumerate() {
            let n = i + 1;
            let rid = format!("rId{n}");
            ids.push_str(&format!(r#"<p:sldId id="{}" r:id="{rid}"/>"#, 255 + n));
            rels.push_str(&format!(
                r#"<Relationship Id="{rid}" Target="slides/slide{n}.xml"/>"#
            ));
            zip.start_file(format!("ppt/slides/slide{n}.xml"), opts)
                .unwrap();
            zip.write_all(xml.as_bytes()).unwrap();

            if let Some(notes) = notes {
                zip.start_file(format!("ppt/slides/_rels/slide{n}.xml.rels"), opts)
                    .unwrap();
                zip.write_all(
                    format!(
                        r#"<Relationships><Relationship Id="rId9" Target="../notesSlides/notesSlide{n}.xml"/></Relationships>"#
                    )
                    .as_bytes(),
                )
                .unwrap();
                zip.start_file(format!("ppt/notesSlides/notesSlide{n}.xml"), opts)
                    .unwrap();
                zip.write_all(notes.as_bytes()).unwrap();
            }
        }

        zip.start_file("ppt/presentation.xml", opts).unwrap();
        zip.write_all(
            format!(
                r#"<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>{ids}</p:sldIdLst></p:presentation>"#
            )
            .as_bytes(),
        )
        .unwrap();
        zip.start_file("ppt/_rels/presentation.xml.rels", opts)
            .unwrap();
        zip.write_all(format!("<Relationships>{rels}</Relationships>").as_bytes())
            .unwrap();

        zip.finish().unwrap().into_inner()
    }

    fn plain(text: &str) -> String {
        slide_xml(&shape(Some("title"), &[(0, text)]))
    }

    // ─── Pure helpers ───────────────────────────────────────────────────────

    #[test]
    fn relationship_targets_resolve_relative_to_their_own_part() {
        assert_eq!(
            join_target("ppt/slides", "../notesSlides/notesSlide1.xml"),
            "ppt/notesSlides/notesSlide1.xml"
        );
        assert_eq!(
            join_target("ppt", "slides/slide1.xml"),
            "ppt/slides/slide1.xml"
        );
        // An absolute target is package-rooted, not folder-relative.
        assert_eq!(
            join_target("ppt/slides", "/ppt/media/a.png"),
            "ppt/media/a.png"
        );
    }

    #[test]
    fn a_parts_rels_file_lives_beside_it_in_underscore_rels() {
        assert_eq!(
            rels_path("ppt/slides/slide1.xml"),
            "ppt/slides/_rels/slide1.xml.rels"
        );
    }

    // ─── Round-trips through a real package ─────────────────────────────────

    #[test]
    fn slides_come_back_in_running_order_not_file_name_order() {
        // Ten slides: sorted by name, slide10 would land second.
        let slides: Vec<(String, Option<String>)> = (1..=10)
            .map(|n| (plain(&format!("第{n}页")), None))
            .collect();
        let md = convert_range(deck(slides), 1, MAX_IMPORT_CHARS)
            .unwrap()
            .markdown;
        let second = md.find("第2页").unwrap();
        let tenth = md.find("第10页").unwrap();
        assert!(second < tenth, "{md}");
        assert!(md.contains("## Slide 10 · 第10页"), "{md}");
    }

    #[test]
    fn a_title_becomes_the_heading_and_body_text_becomes_nested_bullets() {
        let xml = slide_xml(&format!(
            "{}{}",
            shape(Some("title"), &[(0, "方案概览")]),
            shape(Some("body"), &[(0, "背景"), (1, "细节"), (2, "更细")]),
        ));
        let md = convert_range(deck(vec![(xml, None)]), 1, MAX_IMPORT_CHARS)
            .unwrap()
            .markdown;
        assert!(md.contains("## Slide 1 · 方案概览"), "{md}");
        assert!(md.contains("\n- 背景"), "{md}");
        assert!(md.contains("\n  - 细节"), "{md}");
        assert!(md.contains("\n    - 更细"), "{md}");
        // The title is the heading, not also a bullet.
        assert!(!md.contains("- 方案概览"), "{md}");
    }

    #[test]
    fn every_slide_carries_a_citable_marker() {
        let slides: Vec<(String, Option<String>)> =
            (1..=3).map(|n| (plain(&format!("T{n}")), None)).collect();
        let md = convert_range(deck(slides), 1, MAX_IMPORT_CHARS)
            .unwrap()
            .markdown;
        for n in 1..=3 {
            assert!(md.contains(&format!("<!-- slide {n} -->")), "{md}");
        }
    }

    #[test]
    fn speaker_notes_survive_and_the_thumbnail_copy_does_not() {
        let notes = format!(
            r#"<?xml version="1.0"?><p:notes xmlns:p="p" xmlns:a="a">{}{}</p:notes>"#,
            // The notes part repeats the slide's own text in a thumbnail
            // placeholder; only the body placeholder is real.
            shape(Some("sldImg"), &[(0, "封面标题")]),
            shape(Some("body"), &[(0, "这里要放慢语速")]),
        );
        let md = convert_range(
            deck(vec![(plain("封面标题"), Some(notes))]),
            1,
            MAX_IMPORT_CHARS,
        )
        .unwrap()
        .markdown;
        assert!(md.contains("> **Notes:** 这里要放慢语速"), "{md}");
        assert_eq!(md.matches("封面标题").count(), 1, "{md}");
    }

    #[test]
    fn a_table_becomes_a_markdown_table_with_pipes_neutralised() {
        let xml = slide_xml(
            r#"<p:graphicFrame><a:tbl>
              <a:tr><a:tc><a:txBody><a:p><a:r><a:t>项目</a:t></a:r></a:p></a:txBody></a:tc>
                    <a:tc><a:txBody><a:p><a:r><a:t>金额</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
              <a:tr><a:tc><a:txBody><a:p><a:r><a:t>a|b</a:t></a:r></a:p></a:txBody></a:tc>
                    <a:tc><a:txBody><a:p><a:r><a:t>12</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
            </a:tbl></p:graphicFrame>"#,
        );
        let md = convert_range(deck(vec![(xml, None)]), 1, MAX_IMPORT_CHARS)
            .unwrap()
            .markdown;
        assert!(md.contains("| 项目 | 金额 |"), "{md}");
        assert!(md.contains("| --- | --- |"), "{md}");
        assert!(md.contains(r"| a\|b | 12 |"), "{md}");
    }

    #[test]
    fn an_embedded_picture_is_named_rather_than_dropped() {
        let xml =
            slide_xml(r#"<p:pic><p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill></p:pic>"#);
        // The picture relationship rides on the slide's own rels part, which
        // the fixture only writes when there are notes — so build the deck by
        // hand here.
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default();
        zip.start_file("ppt/slides/slide1.xml", opts).unwrap();
        zip.write_all(xml.as_bytes()).unwrap();
        zip.start_file("ppt/slides/_rels/slide1.xml.rels", opts)
            .unwrap();
        zip.write_all(
            br#"<Relationships><Relationship Id="rIdImg" Target="../media/image7.png"/></Relationships>"#,
        )
        .unwrap();
        zip.start_file("ppt/presentation.xml", opts).unwrap();
        zip.write_all(
            br#"<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>"#,
        )
        .unwrap();
        zip.start_file("ppt/_rels/presentation.xml.rels", opts)
            .unwrap();
        zip.write_all(
            br#"<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>"#,
        )
        .unwrap();
        let bytes = zip.finish().unwrap().into_inner();

        let md = convert_range(bytes, 1, MAX_IMPORT_CHARS).unwrap().markdown;
        assert!(md.contains("_[image: image7.png]_"), "{md}");
    }

    #[test]
    fn a_slide_with_no_text_says_so_instead_of_rendering_blank() {
        let md = convert_range(deck(vec![(slide_xml(""), None)]), 1, MAX_IMPORT_CHARS)
            .unwrap()
            .markdown;
        assert!(md.contains("_(no text on this slide)_"), "{md}");
    }

    // ─── Paging ─────────────────────────────────────────────────────────────

    #[test]
    fn a_budget_stops_on_a_slide_boundary_and_says_where_to_resume() {
        let slides: Vec<(String, Option<String>)> = (1..=20)
            .map(|n| (plain(&format!("第{n}页")), None))
            .collect();
        let first = convert_range(deck(slides.clone()), 1, 500).unwrap();
        assert_eq!(first.from_slide, 1);
        assert_eq!(first.total_slides, 20);
        assert!(
            first.to_slide < 20,
            "budget should not have covered the deck"
        );
        assert_eq!(first.next_slide, Some(first.to_slide + 1));
        // Whole slides only: the last one shown is complete.
        assert!(
            first.markdown.contains(&format!("第{}页", first.to_slide)),
            "{}",
            first.markdown
        );

        let second = convert_range(deck(slides), first.next_slide.unwrap(), 500).unwrap();
        assert_eq!(second.from_slide, first.to_slide + 1);
        assert!(
            !second.markdown.contains("<!-- slide 1 -->"),
            "{}",
            second.markdown
        );
    }

    #[test]
    fn the_last_page_reports_no_next_slide() {
        let slides: Vec<(String, Option<String>)> = (1..=3)
            .map(|n| (plain(&format!("第{n}页")), None))
            .collect();
        let range = convert_range(deck(slides), 1, MAX_IMPORT_CHARS).unwrap();
        assert_eq!(range.to_slide, 3);
        assert_eq!(range.next_slide, None);
    }

    #[test]
    fn one_oversized_slide_still_comes_back() {
        // The first slide of a range is always taken, however long — a budget
        // that returns nothing leaves the reader with no way forward.
        let long = "字".repeat(3000);
        let range = convert_range(deck(vec![(plain(&long), None)]), 1, 500).unwrap();
        assert!(range.markdown.contains(&long), "{}", range.markdown);
        assert_eq!(range.to_slide, 1);
    }

    #[test]
    fn a_slide_past_the_end_is_an_error_naming_the_real_count() {
        let err = convert_range(deck(vec![(plain("只有一页"), None)]), 5, 4000).unwrap_err();
        assert!(err.contains('5') && err.contains("1 slide"), "{err}");
    }

    #[test]
    fn garbage_bytes_are_an_error_not_a_panic() {
        assert!(convert_range(b"not a presentation".to_vec(), 1, 4000).is_err());
    }

    #[test]
    fn a_zip_without_a_presentation_part_is_an_error() {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file("hello.txt", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"hi").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        assert!(convert_range(bytes, 1, 4000).is_err());
    }
}
