//! A typed grid → .xlsx bytes.
//!
//! The other half of `xlsx.rs`, and in Rust for the same reason: the workbook
//! libraries live here. `rust_xlsxwriter` was already in the tree building the
//! fixtures that module's round-trip tests read back, so the write side costs a
//! promotion from dev-dependency and nothing else — where the maintained JS
//! options are the ones xlsx.rs already turned down (the npm `xlsx` build is
//! stale and carries advisories; ExcelJS is a megabyte in the startup path).
//!
//! **Nothing here parses markdown.** The frontend has already split the
//! document into sheets and decided what every cell *is* (`lib/xlsx/cells.ts`);
//! what crosses the IPC boundary is a grid whose types are settled. That is
//! what makes generating in Rust right here and wrong for .docx, where
//! generating means parsing markdown first and the dialect lives in TS — see
//! docs/feature/xlsx-export-plan.md D1.
//!
//! Bytes go back as base64 rather than a JSON array of numbers: same payload,
//! a quarter of the size.

use std::collections::HashMap;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rust_xlsxwriter::{ExcelDateTime, Format, Formula, Workbook, Worksheet};
use serde::Deserialize;
use tauri::command;

/// One cell, already classified by the frontend.
///
/// Internally tagged so the wire form stays legible in a log: `{"t":"n","v":
/// 12000,"fmt":"#,##0"}`. `fmt` is an Excel number-format string and is only
/// ever present when the source text itself expressed a format (thousands
/// separators, a fixed number of decimals, a currency symbol, a percent sign).
#[derive(Debug, Deserialize)]
#[serde(tag = "t")]
enum CellSpec {
    #[serde(rename = "s")]
    Text { v: String },
    #[serde(rename = "n")]
    Number {
        v: f64,
        #[serde(default)]
        fmt: Option<String>,
    },
    /// ISO 8601: `2026-08-06` or `2026-08-06T13:45:00`.
    #[serde(rename = "d")]
    Date {
        v: String,
        #[serde(default)]
        fmt: Option<String>,
    },
    #[serde(rename = "b")]
    Bool { v: bool },
    #[serde(rename = "f")]
    Formula { v: String },
}

#[derive(Debug, Deserialize)]
pub struct SheetSpec {
    name: String,
    rows: Vec<Vec<CellSpec>>,
    /// First row is a header: bold, and the pane freezes under it.
    #[serde(default)]
    header: bool,
}

/// `2026-08-06` / `2026-08-06T13:45:00` → an Excel serial date.
///
/// Parsed by hand rather than through a date crate: the frontend has already
/// validated the value (a 2 月 30 日 never becomes a date there, it stays
/// text), so all this needs is to read six numbers out of a fixed shape. A
/// string that somehow does not fit is written as text by the caller — losing
/// the value would be worse than losing the type.
fn parse_datetime(text: &str) -> Option<ExcelDateTime> {
    let (date, time) = match text.split_once('T') {
        Some((d, t)) => (d, Some(t)),
        None => (text, None),
    };
    let mut parts = date.split('-');
    let year: u16 = parts.next()?.parse().ok()?;
    let month: u8 = parts.next()?.parse().ok()?;
    let day: u8 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let stamp = ExcelDateTime::from_ymd(year, month, day).ok()?;

    let Some(time) = time else { return Some(stamp) };
    let mut clock = time.split(':');
    let hour: u16 = clock.next()?.parse().ok()?;
    let minute: u8 = clock.next()?.parse().ok()?;
    let second: f64 = match clock.next() {
        Some(s) => s.parse().ok()?,
        None => 0.0,
    };
    stamp.and_hms(hour, minute, second).ok()
}

/// Formats are per-workbook objects, so a sheet of 5,000 currency cells must
/// not build 5,000 of them.
struct Formats {
    header: Format,
    by_num_format: HashMap<String, Format>,
    date: Format,
}

impl Formats {
    fn new() -> Self {
        Self {
            header: Format::new().set_bold(),
            by_num_format: HashMap::new(),
            date: Format::new().set_num_format("yyyy-mm-dd"),
        }
    }

    fn numeric(&mut self, fmt: &str) -> &Format {
        self.by_num_format
            .entry(fmt.to_string())
            .or_insert_with(|| Format::new().set_num_format(fmt))
    }
}

fn write_cell(
    sheet: &mut Worksheet,
    row: u32,
    col: u16,
    cell: &CellSpec,
    formats: &mut Formats,
) -> Result<(), String> {
    let result = match cell {
        // An empty cell is left empty rather than written as "": a blank cell
        // and a cell holding a zero-length string count differently in COUNTA
        // and look identical, which is the worst pair of properties to have.
        CellSpec::Text { v } if v.is_empty() => Ok(()),
        CellSpec::Text { v } => sheet.write_string(row, col, v).map(|_| ()),
        CellSpec::Number { v, fmt } => match fmt {
            Some(fmt) => sheet
                .write_number_with_format(row, col, *v, formats.numeric(fmt))
                .map(|_| ()),
            None => sheet.write_number(row, col, *v).map(|_| ()),
        },
        CellSpec::Bool { v } => sheet.write_boolean(row, col, *v).map(|_| ()),
        // No cached result is written, so a spreadsheet app recalculates on
        // open — Excel and LibreOffice both do. A preview that only reads the
        // stored value (Quick Look, some web viewers) shows a blank until then;
        // that is reported to the author rather than worked around, because the
        // alternative is this app evaluating spreadsheet formulas.
        CellSpec::Formula { v } => sheet
            .write_formula(row, col, Formula::new(v.as_str()))
            .map(|_| ()),
        CellSpec::Date { v, fmt } => match parse_datetime(v) {
            Some(stamp) => {
                let format = match fmt {
                    Some(fmt) => formats.numeric(fmt),
                    None => &formats.date,
                };
                sheet
                    .write_datetime_with_format(row, col, stamp, format)
                    .map(|_| ())
            }
            None => sheet.write_string(row, col, v).map(|_| ()),
        },
    };
    result.map_err(|e| format!("Could not write cell: {e}"))
}

fn build(sheets: &[SheetSpec]) -> Result<Vec<u8>, String> {
    if sheets.is_empty() {
        return Err("There are no tables to export.".to_string());
    }

    let mut workbook = Workbook::new();
    let mut formats = Formats::new();

    for spec in sheets {
        let sheet = workbook.add_worksheet();
        // Excel's own rules (31 chars, no `:\/?*[]`, unique) are enforced in
        // `lib/xlsx/sheets.ts`, where the names are made; a name that still
        // fails here is a bug in that layer and must be loud, not repaired
        // twice in two places with rules that will drift apart.
        sheet
            .set_name(&spec.name)
            .map_err(|e| format!("Sheet name \"{}\" was rejected: {e}", spec.name))?;

        for (r, row) in spec.rows.iter().enumerate() {
            for (c, cell) in row.iter().enumerate() {
                let (Ok(r), Ok(c)) = (u32::try_from(r), u16::try_from(c)) else {
                    return Err("That table is larger than a worksheet can hold.".to_string());
                };
                if spec.header && r == 0 {
                    // The header row is bold whatever the cell holds, so it is
                    // written as text — a heading that reads "2026" is a label,
                    // not a number anyone will sum.
                    let text = match cell {
                        CellSpec::Text { v } => v.clone(),
                        CellSpec::Number { v, .. } => format!("{v}"),
                        CellSpec::Bool { v } => v.to_string(),
                        CellSpec::Date { v, .. } | CellSpec::Formula { v } => v.clone(),
                    };
                    sheet
                        .write_string_with_format(r, c, &text, &formats.header)
                        .map_err(|e| format!("Could not write header cell: {e}"))?;
                } else {
                    write_cell(sheet, r, c, cell, &mut formats)?;
                }
            }
        }

        if spec.header && spec.rows.len() > 1 {
            sheet
                .set_freeze_panes(1, 0)
                .map_err(|e| format!("Could not freeze the header row: {e}"))?;
        }
        // Without this every column is Excel's default 8.43 characters wide and
        // a sheet of Chinese labels opens as a wall of `####`.
        sheet.autofit();
    }

    workbook
        .save_to_buffer()
        .map_err(|e| format!("Could not assemble the workbook: {e}"))
}

/// Build a workbook and hand it back as base64. Writing it to disk stays with
/// the frontend's existing binary writer — see `lib/xlsx/write.ts`.
#[command]
pub fn xlsx_write_workbook(sheets: Vec<SheetSpec>) -> Result<String, String> {
    Ok(BASE64.encode(build(&sheets)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::{Data, Reader, Xlsx};
    use std::io::Cursor;

    fn text(v: &str) -> CellSpec {
        CellSpec::Text { v: v.to_string() }
    }

    fn read_back(bytes: Vec<u8>) -> Xlsx<Cursor<Vec<u8>>> {
        Xlsx::new(Cursor::new(bytes)).expect("a readable workbook")
    }

    #[test]
    fn a_sheet_keeps_its_name_and_its_cells() {
        let bytes = build(&[SheetSpec {
            name: "报价表".into(),
            header: true,
            rows: vec![
                vec![text("项目"), text("单价")],
                vec![
                    text("服务器"),
                    CellSpec::Number {
                        v: 12000.0,
                        fmt: Some("#,##0".into()),
                    },
                ],
            ],
        }])
        .unwrap();

        let mut book = read_back(bytes);
        assert_eq!(book.sheet_names(), vec!["报价表"]);
        let range = book.worksheet_range("报价表").unwrap();
        assert_eq!(range.get_value((0, 0)), Some(&Data::String("项目".into())));
        // The point of the whole feature: a price arrives as a number, not as
        // the text "12000".
        assert_eq!(range.get_value((1, 1)), Some(&Data::Float(12000.0)));
    }

    #[test]
    fn formulas_and_booleans_survive_as_themselves() {
        let bytes = build(&[SheetSpec {
            name: "S".into(),
            header: false,
            rows: vec![vec![
                CellSpec::Formula { v: "=B1*2".into() },
                CellSpec::Bool { v: true },
            ]],
        }])
        .unwrap();

        let mut book = read_back(bytes);
        let formulas = book.worksheet_formula("S").unwrap();
        assert_eq!(
            formulas
                .used_cells()
                .map(|(_, _, f)| f.clone())
                .collect::<Vec<_>>(),
            vec!["B1*2".to_string()]
        );
        let range = book.worksheet_range("S").unwrap();
        assert_eq!(range.get_value((0, 1)), Some(&Data::Bool(true)));
    }

    #[test]
    fn a_date_lands_as_a_date_rather_than_a_string() {
        let bytes = build(&[SheetSpec {
            name: "S".into(),
            header: false,
            rows: vec![vec![CellSpec::Date {
                v: "2026-08-06".into(),
                fmt: Some("yyyy-mm-dd".into()),
            }]],
        }])
        .unwrap();

        let mut book = read_back(bytes);
        let range = book.worksheet_range("S").unwrap();
        match range.get_value((0, 0)) {
            Some(Data::DateTime(d)) => {
                assert_eq!(d.as_datetime().unwrap().date().to_string(), "2026-08-06")
            }
            other => panic!("expected a date cell, got {other:?}"),
        }
    }

    #[test]
    fn an_unparseable_date_keeps_its_text_instead_of_vanishing() {
        let bytes = build(&[SheetSpec {
            name: "S".into(),
            header: false,
            rows: vec![vec![CellSpec::Date {
                v: "not-a-date".into(),
                fmt: None,
            }]],
        }])
        .unwrap();

        let mut book = read_back(bytes);
        let range = book.worksheet_range("S").unwrap();
        assert_eq!(
            range.get_value((0, 0)),
            Some(&Data::String("not-a-date".into()))
        );
    }

    #[test]
    fn datetimes_carry_their_clock() {
        let stamp = parse_datetime("2026-08-06T13:45:30").expect("parsed");
        assert!(parse_datetime("2026-08-06").is_some());
        assert!(parse_datetime("2026-08").is_none());
        assert!(parse_datetime("2026-08-06-07").is_none());
        // Serial dates count from 1899-12-30; the fractional part is the clock,
        // and 13:45:30 is a bit past half past.
        let serial = stamp.to_excel();
        assert!(serial.fract() > 0.5 && serial.fract() < 0.6, "{serial}");
    }

    #[test]
    fn every_sheet_in_the_book_is_written() {
        let bytes = build(&[
            SheetSpec {
                name: "一".into(),
                header: false,
                rows: vec![vec![text("a")]],
            },
            SheetSpec {
                name: "二".into(),
                header: false,
                rows: vec![vec![text("b")]],
            },
        ])
        .unwrap();
        assert_eq!(read_back(bytes).sheet_names(), vec!["一", "二"]);
    }

    #[test]
    fn an_empty_book_is_an_error_not_a_blank_file() {
        assert!(build(&[]).is_err());
    }

    #[test]
    fn a_name_excel_forbids_is_reported_rather_than_silently_repaired() {
        let err = build(&[SheetSpec {
            name: "a/b".into(),
            header: false,
            rows: vec![vec![text("x")]],
        }])
        .unwrap_err();
        assert!(err.contains("a/b"), "{err}");
    }

    #[test]
    fn the_grid_survives_a_round_trip_through_the_importer() {
        // The two directions are each other's inverse, and this is where that
        // is pinned: what `xlsx.rs` renders as markdown is what this module
        // wrote.
        let bytes = build(&[SheetSpec {
            name: "报价".into(),
            header: true,
            rows: vec![
                vec![text("项目"), text("金额")],
                vec![
                    text("服务器"),
                    CellSpec::Number {
                        v: 12000.0,
                        fmt: None,
                    },
                ],
            ],
        }])
        .unwrap();
        let md = crate::xlsx::xlsx_to_markdown(bytes).unwrap();
        assert!(md.contains("## 报价"), "{md}");
        assert!(md.contains("| 项目 | 金额 |"), "{md}");
        assert!(md.contains("| 服务器 | 12000 |"), "{md}");
    }
}
