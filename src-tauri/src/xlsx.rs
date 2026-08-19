//! .xlsx → Markdown, in Rust rather than the webview.
//!
//! The rest of the import pipeline (docx via mammoth, pdf via pdfjs) converts
//! in the frontend, so this module is the odd one out and the reason is the
//! parser: `calamine` reads the workbook's *semantics* — cached formula
//! results, real dates instead of serial numbers, merged ranges — where the
//! maintained JS options either can't or aren't distributable (the npm `xlsx`
//! build is stale and carries advisories; ExcelJS drops the legacy formats).
//!
//! A flat "one markdown table per sheet" would throw away exactly the parts an
//! author cares about in a quote sheet, so the three lossy spots get their own
//! blocks after the table: which cells were formulas, which ranges were merged,
//! and where the row cap truncated. See `sheet_to_markdown`.
//!
//! Bytes come in over IPC rather than a path on purpose. The frontend has
//! already read the file (the dialog plugin scopes the picked path for
//! `tauri-plugin-fs`), so taking a path here would add a second, *unscoped*
//! read primitive to the command surface for no gain — see scope.rs.

use calamine::{Data, Reader, Xlsx};
use std::io::Cursor;
use tauri::command;

/// Rows emitted per sheet before the table is cut short. A workbook used as a
/// data dump can run to hundreds of thousands of rows, which would render a
/// markdown file no one — author or model — can read. The cut is always
/// announced in the output; silent truncation would look like a short sheet.
const MAX_ROWS_PER_SHEET: usize = 5000;

/// Characters kept from one cell. Long prose in a cell is usually a note or a
/// pasted paragraph; the whole thing would wreck the table's readability.
const MAX_CELL_CHARS: usize = 500;

/// Formula lines listed per sheet. The block exists to show *how* the numbers
/// were derived; a sheet with 10k formulas has one pattern repeated, not 10k
/// insights.
const MAX_FORMULAS_PER_SHEET: usize = 100;

/// 0 → "A", 25 → "Z", 26 → "AA". Excel's bijective base-26, used so the
/// formula and merged-range blocks can name cells the way the author's
/// spreadsheet does.
fn col_letters(mut idx: u32) -> String {
    let mut out = Vec::new();
    loop {
        out.push(b'A' + (idx % 26) as u8);
        if idx < 26 {
            break;
        }
        idx = idx / 26 - 1;
    }
    out.reverse();
    String::from_utf8(out).expect("ASCII only")
}

/// `(row, col)` zero-based → "B7" one-based.
fn cell_ref(row: u32, col: u32) -> String {
    format!("{}{}", col_letters(col), row + 1)
}

/// Make one cell safe to sit inside a markdown table row: pipes would end the
/// cell early and newlines would end the row, so both are neutralised rather
/// than dropped.
pub(crate) fn escape_cell(raw: &str) -> String {
    let trimmed = raw.trim();
    let clipped: String = if trimmed.chars().count() > MAX_CELL_CHARS {
        trimmed
            .chars()
            .take(MAX_CELL_CHARS)
            .chain("…".chars())
            .collect()
    } else {
        trimmed.to_string()
    };
    clipped
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace("\r\n", "<br>")
        .replace(['\n', '\r'], "<br>")
}

/// Render one cell value as text.
///
/// Floats are the fiddly case: Excel stores every number as f64, so a count of
/// 2 arrives as `2.0` and rendering it verbatim would put "2.0" in a quantity
/// column. Whole numbers therefore print as integers, and everything else
/// keeps Rust's shortest round-trip form.
fn format_data(value: &Data) -> String {
    match value {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                format!("{f}")
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        // Only reachable with the `dates` feature on; without it these arrive
        // as Float and the author gets a serial number like 45678.
        Data::DateTime(dt) => match dt.as_datetime() {
            Some(d) => d.to_string(),
            None => dt.as_f64().to_string(),
        },
        Data::DateTimeIso(s) => s.clone(),
        Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("#ERROR({e:?})"),
    }
}

/// Assemble a markdown table from already-escaped cells.
///
/// The first row becomes the header because that is what a spreadsheet almost
/// always puts there, and a table with a real header reads far better than one
/// keyed by column letters. Kept pure and separate from the workbook so the
/// layout rules are testable without a fixture file.
fn render_table(rows: &[Vec<String>]) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    if width == 0 {
        return String::new();
    }

    let line = |cells: &[String]| -> String {
        let mut padded: Vec<&str> = cells.iter().map(String::as_str).collect();
        padded.resize(width, "");
        format!("| {} |", padded.join(" | "))
    };

    let mut out = vec![
        line(&rows[0]),
        format!("| {} |", vec!["---"; width].join(" | ")),
    ];
    out.extend(rows[1..].iter().map(|r| line(r)));
    out.join("\n")
}

/// One sheet as a markdown section: heading, table, then the blocks carrying
/// what a plain table cannot (formulas, merges, truncation).
fn sheet_to_markdown(
    name: &str,
    cells: &[Vec<String>],
    total_rows: usize,
    formulas: &[(String, String)],
    merges: &[String],
) -> String {
    let mut parts = vec![format!("## {name}")];

    if cells.is_empty() {
        parts.push("_(empty sheet)_".to_string());
        return parts.join("\n\n");
    }

    parts.push(render_table(cells));

    if total_rows > cells.len() {
        parts.push(format!(
            "_[... {} more row(s) not shown — the sheet has {total_rows} rows, capped at {MAX_ROWS_PER_SHEET} ...]_",
            total_rows - cells.len()
        ));
    }

    if !formulas.is_empty() {
        let shown = formulas.len().min(MAX_FORMULAS_PER_SHEET);
        let mut block = vec!["**Formulas**".to_string()];
        block.extend(
            formulas[..shown]
                .iter()
                .map(|(at, f)| format!("- {at} = {f}")),
        );
        if formulas.len() > shown {
            block.push(format!("- [... {} more ...]", formulas.len() - shown));
        }
        parts.push(block.join("\n"));
    }

    if !merges.is_empty() {
        parts.push(format!("**Merged cells**: {}", merges.join(", ")));
    }

    parts.join("\n\n")
}

/// Convert a whole workbook. Split from the command so the conversion is
/// reachable from tests without a Tauri runtime.
fn workbook_to_markdown(data: Vec<u8>) -> Result<String, String> {
    let mut workbook: Xlsx<_> =
        Xlsx::new(Cursor::new(data)).map_err(|e| format!("Not a readable .xlsx file: {e}"))?;

    let mut sections: Vec<String> = Vec::new();
    for name in workbook.sheet_names() {
        let range = match workbook.worksheet_range(&name) {
            Ok(r) => r,
            // One unreadable sheet must not lose the other nine.
            Err(e) => {
                sections.push(format!("## {name}\n\n_(could not be read: {e})_"));
                continue;
            }
        };

        let total_rows = range.rows().count();
        let cells: Vec<Vec<String>> = range
            .rows()
            .take(MAX_ROWS_PER_SHEET)
            .map(|row| row.iter().map(|c| escape_cell(&format_data(c))).collect())
            .collect();
        // A sheet whose cells are all blank renders as a table of empty pipes,
        // which is noise; treat it as empty.
        let cells = if cells.iter().flatten().all(String::is_empty) {
            Vec::new()
        } else {
            cells
        };

        let formulas: Vec<(String, String)> = workbook
            .worksheet_formula(&name)
            .map(|f| {
                let base = f.start().unwrap_or((0, 0));
                f.used_cells()
                    .filter(|(_, _, text)| !text.is_empty())
                    .map(|(r, c, text)| {
                        (cell_ref(base.0 + r as u32, base.1 + c as u32), text.clone())
                    })
                    .collect()
            })
            .unwrap_or_default();

        let merges: Vec<String> = workbook
            .merge_cells_by_sheet_name(&name)
            .map(|dims| {
                dims.iter()
                    .map(|dim| {
                        format!(
                            "{}:{}",
                            cell_ref(dim.start.0, dim.start.1),
                            cell_ref(dim.end.0, dim.end.1)
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();

        sections.push(sheet_to_markdown(
            &name, &cells, total_rows, &formulas, &merges,
        ));
    }

    if sections.is_empty() {
        return Ok(String::new());
    }
    Ok(sections.join("\n\n"))
}

/// Convert .xlsx bytes to Markdown. Errors are returned as text so the import
/// dialog can report this file and keep going with the rest of the batch.
#[command]
pub fn xlsx_to_markdown(data: Vec<u8>) -> Result<String, String> {
    workbook_to_markdown(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_letters_follow_excel() {
        assert_eq!(col_letters(0), "A");
        assert_eq!(col_letters(25), "Z");
        assert_eq!(col_letters(26), "AA");
        assert_eq!(col_letters(27), "AB");
        assert_eq!(col_letters(51), "AZ");
        assert_eq!(col_letters(52), "BA");
        assert_eq!(col_letters(701), "ZZ");
        assert_eq!(col_letters(702), "AAA");
    }

    #[test]
    fn cell_refs_are_one_based() {
        assert_eq!(cell_ref(0, 0), "A1");
        assert_eq!(cell_ref(6, 1), "B7");
    }

    #[test]
    fn pipes_and_newlines_cannot_break_the_table() {
        assert_eq!(escape_cell("a|b"), "a\\|b");
        assert_eq!(escape_cell("line1\nline2"), "line1<br>line2");
        assert_eq!(escape_cell("line1\r\nline2"), "line1<br>line2");
        assert_eq!(escape_cell("  padded  "), "padded");
    }

    #[test]
    fn long_cells_are_clipped_not_dropped() {
        let long = "x".repeat(MAX_CELL_CHARS + 50);
        let out = escape_cell(&long);
        assert_eq!(out.chars().count(), MAX_CELL_CHARS + 1);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn whole_floats_render_without_a_decimal_tail() {
        assert_eq!(format_data(&Data::Float(2.0)), "2");
        assert_eq!(format_data(&Data::Float(24000.0)), "24000");
        assert_eq!(format_data(&Data::Float(1.5)), "1.5");
        assert_eq!(format_data(&Data::Int(7)), "7");
        assert_eq!(format_data(&Data::Empty), "");
    }

    #[test]
    fn first_row_becomes_the_header() {
        let rows = vec![
            vec!["Item".into(), "Qty".into()],
            vec!["Server".into(), "2".into()],
        ];
        assert_eq!(
            render_table(&rows),
            "| Item | Qty |\n| --- | --- |\n| Server | 2 |"
        );
    }

    #[test]
    fn short_rows_are_padded_to_the_widest_row() {
        let rows = vec![vec!["A".into()], vec!["B".into(), "C".into()]];
        assert_eq!(render_table(&rows), "| A |  |\n| --- | --- |\n| B | C |");
    }

    #[test]
    fn empty_sheet_says_so_instead_of_rendering_an_empty_table() {
        let out = sheet_to_markdown("Sheet1", &[], 0, &[], &[]);
        assert!(out.contains("_(empty sheet)_"));
        assert!(!out.contains('|'));
    }

    #[test]
    fn truncation_is_announced_with_the_real_row_count() {
        let cells = vec![vec!["h".into()], vec!["v".into()]];
        let out = sheet_to_markdown("S", &cells, 9000, &[], &[]);
        assert!(out.contains("8998 more row(s) not shown"));
        assert!(out.contains("9000 rows"));
    }

    #[test]
    fn formulas_and_merges_are_kept_beside_the_table() {
        let cells = vec![vec!["h".into()], vec!["v".into()]];
        let formulas = vec![("E2".to_string(), "C2*D2".to_string())];
        let merges = vec!["A1:E1".to_string()];
        let out = sheet_to_markdown("S", &cells, 2, &formulas, &merges);
        assert!(out.contains("- E2 = C2*D2"));
        assert!(out.contains("**Merged cells**: A1:E1"));
    }

    #[test]
    fn formula_list_is_capped() {
        let cells = vec![vec!["h".into()]];
        let formulas: Vec<(String, String)> = (0..MAX_FORMULAS_PER_SHEET + 20)
            .map(|i| (format!("A{i}"), "1+1".to_string()))
            .collect();
        let out = sheet_to_markdown("S", &cells, 1, &formulas, &[]);
        assert!(out.contains("[... 20 more ...]"));
    }

    #[test]
    fn garbage_bytes_are_an_error_not_a_panic() {
        assert!(workbook_to_markdown(b"not a spreadsheet".to_vec()).is_err());
    }

    // ─── Round-trips through a real workbook ────────────────────────────────
    //
    // The tests above cover the layout rules; these cover the calamine calls,
    // which is where a version bump would break things silently — a changed
    // return shape still compiles if it is merely emptier than before, and the
    // pure tests would keep passing while every import came out blank.

    use rust_xlsxwriter::{Format, Formula, Workbook};

    #[test]
    fn a_real_workbook_keeps_its_table_formulas_and_merges() {
        let mut book = Workbook::new();
        let sheet = book.add_worksheet();
        sheet.set_name("报价表").unwrap();
        sheet
            .merge_range(0, 0, 0, 2, "2026 年度报价", &Format::new())
            .unwrap();
        sheet.write_string(1, 0, "项目").unwrap();
        sheet.write_string(1, 1, "单价").unwrap();
        sheet.write_string(1, 2, "金额").unwrap();
        sheet.write_string(2, 0, "服务器").unwrap();
        sheet.write_number(2, 1, 12000.0).unwrap();
        sheet
            .write_formula(2, 2, Formula::new("=B3*2").set_result("24000"))
            .unwrap();
        let md = workbook_to_markdown(book.save_to_buffer().unwrap()).unwrap();

        assert!(md.contains("## 报价表"), "{md}");
        assert!(md.contains("服务器"), "{md}");
        // Excel stores every number as f64 — a price must not read "12000.0".
        assert!(md.contains("| 12000 |"), "{md}");
        assert!(!md.contains("12000.0"), "{md}");
        // The cached result is what a plain table would show; the formula that
        // produced it survives in its own block, addressed the way the author's
        // spreadsheet addresses it.
        assert!(md.contains("**Formulas**"), "{md}");
        assert!(md.contains("C3 = "), "{md}");
        assert!(md.contains("B3*2"), "{md}");
        assert!(md.contains("**Merged cells**: A1:C1"), "{md}");
    }

    #[test]
    fn every_sheet_is_emitted_and_blank_ones_say_so() {
        let mut book = Workbook::new();
        let first = book.add_worksheet();
        first.set_name("有数据").unwrap();
        first.write_string(0, 0, "值").unwrap();
        let second = book.add_worksheet();
        second.set_name("空表").unwrap();
        let md = workbook_to_markdown(book.save_to_buffer().unwrap()).unwrap();

        assert!(md.contains("## 有数据"), "{md}");
        assert!(md.contains("## 空表"), "{md}");
        assert!(md.contains("_(empty sheet)_"), "{md}");
        // The blank sheet must not contribute a table of empty pipes.
        assert_eq!(md.matches("| --- |").count(), 1, "{md}");
    }

    #[test]
    fn date_cells_survive_as_dates_rather_than_serial_numbers() {
        let mut book = Workbook::new();
        let sheet = book.add_worksheet();
        sheet.write_string(0, 0, "交付日期").unwrap();
        // The number format is what makes this a date rather than a number —
        // Excel stores both as the same f64, and it is the format that tells
        // calamine (and Excel itself) which one the author meant. A cell
        // without one really is just a number, so the fixture has to carry it.
        sheet
            .write_datetime_with_format(
                1,
                0,
                rust_xlsxwriter::ExcelDateTime::from_ymd(2026, 8, 6).unwrap(),
                &Format::new().set_num_format("yyyy-mm-dd"),
            )
            .unwrap();
        let md = workbook_to_markdown(book.save_to_buffer().unwrap()).unwrap();

        assert!(md.contains("2026-08-06"), "{md}");
        // 46240 is the serial number behind that date — what the author would
        // see in the imported file if the `chrono` feature were ever dropped.
        assert!(!md.contains("46240"), "{md}");
    }
}
