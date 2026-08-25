//! 读一份 .docx 的**排版参数**——不是它的正文。
//!
//! 为什么这件事值得单独存在：读一份 Word 文件的**格式**比读它的**全文**便宜
//! 一个量级。全文保真要面对修订、域、内容控件、编号继承（所以导入端干脆放弃
//! 保真、转成 markdown，见 `src/lib/import/docx.ts`）；而格式只需要
//! `sectPr` 加 `docDefaults` 加四个标题样式里的少数几个属性。
//!
//! 落在 Rust 而不是 webview，理由和 `pptx.rs` / `xlsx.rs` 同一条：zip 读取器和
//! `quick-xml` 已经在这里，前端引一个 zip 库是白加一个依赖。这和「生成端放
//! TS」不冲突——生成要复用 markdown 方言，读格式不需要。
//!
//! **报的是 XML 里写着什么，不解释它是什么意思。** 单位一律原样返回（twip、
//! 半磅、百分之一字符），换算和「缺了就继承」的判断都在 TS 侧——那里已经有
//! 唯一一份单位表（`lib/docx/format.ts`），在这里再写一份必然漂。
//!
//! 样式继承只解一层：读到的是每个样式**自己**声明的属性，`w:basedOn` 链不追。
//! 追下去要实现 Word 的整套样式解析，而这个功能要回答的问题是「这份文件把
//! 什么写死了」——没写死的本来就该落回默认。

use crate::scope::FsScope;
use quick_xml::events::attributes::Attributes;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;
use std::io::{Cursor, Read};
use tauri::{command, State};
use zip::ZipArchive;

/// 一份 .docx 里读到的排版参数。字段全是 `Option`：缺席意味着这份文件没写死
/// 它，而不是它等于零。
#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocxLayout {
    pub page: PageInfo,
    /// `docDefaults` 里的正文默认。
    pub body: BlockInfo,
    /// Heading1–4，按级序。没有声明的那一级是 `None`。
    pub headings: Vec<Option<BlockInfo>>,
}

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    /// twip。
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub landscape: bool,
    /// twip，上右下左。
    pub margin_top: Option<u32>,
    pub margin_right: Option<u32>,
    pub margin_bottom: Option<u32>,
    pub margin_left: Option<u32>,
    /// `w:docGrid` —— 只有 `linesAndChars` / `lines` 才算声明了网格。
    pub grid_type: Option<String>,
    pub grid_line_pitch: Option<u32>,
    pub grid_char_space: Option<i32>,
}

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlockInfo {
    pub font_east_asia: Option<String>,
    pub font_ascii: Option<String>,
    /// 半磅（`w:sz`）。三号 = 16 磅 = 32。
    pub size_half_pt: Option<u32>,
    pub bold: Option<bool>,
    /// `w:jc` 原值：left / center / right / both。
    pub align: Option<String>,
    /// `w:spacing` 的 line / lineRule，twip 与 exact|atLeast|auto。
    pub line: Option<u32>,
    pub line_rule: Option<String>,
    pub space_before: Option<u32>,
    pub space_after: Option<u32>,
    /// `w:ind w:firstLineChars`，百分之一字符（2 字符 = 200）。
    pub first_line_chars: Option<u32>,
    /// `w:ind w:firstLine`，twip。作者用磅写死缩进时才有。
    pub first_line: Option<u32>,
    pub page_break_before: Option<bool>,
}

/// 属性取值，按本地名（去掉 `w:` 前缀）。
fn attr(attrs: Attributes, name: &str) -> Option<String> {
    for a in attrs.flatten() {
        let key = a.key.local_name();
        if key.as_ref() == name.as_bytes() {
            return Some(String::from_utf8_lossy(&a.value).into_owned());
        }
    }
    None
}

fn attr_u32(attrs: Attributes, name: &str) -> Option<u32> {
    attr(attrs, name).and_then(|v| v.parse().ok())
}

/// `w:val` 的布尔读法：缺省即真，只有 `0` / `false` 是假（OOXML 的约定）。
fn on_off(attrs: Attributes) -> bool {
    !matches!(attr(attrs, "val").as_deref(), Some("0") | Some("false"))
}

fn local(name: &[u8]) -> &[u8] {
    match name.iter().position(|b| *b == b':') {
        Some(i) => &name[i + 1..],
        None => name,
    }
}

/// `document.xml` 里的 `sectPr`。取**最后一个**：分节符会让文件里出现多个，
/// 而挂在 body 末尾的那个才是整篇的页面设置。
fn parse_page(xml: &str) -> PageInfo {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut page = PageInfo::default();
    let mut depth_in_sect = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let name = local(e.name().as_ref()).to_vec();
                match name.as_slice() {
                    b"sectPr" => {
                        depth_in_sect = true;
                        // 后一个 sectPr 覆盖前一个——留下的是 body 末尾那个。
                        page = PageInfo::default();
                    }
                    b"pgSz" if depth_in_sect => {
                        page.width = attr_u32(e.attributes(), "w");
                        page.height = attr_u32(e.attributes(), "h");
                        page.landscape =
                            attr(e.attributes(), "orient").as_deref() == Some("landscape");
                    }
                    b"pgMar" if depth_in_sect => {
                        page.margin_top = attr_u32(e.attributes(), "top");
                        page.margin_right = attr_u32(e.attributes(), "right");
                        page.margin_bottom = attr_u32(e.attributes(), "bottom");
                        page.margin_left = attr_u32(e.attributes(), "left");
                    }
                    b"docGrid" if depth_in_sect => {
                        page.grid_type = attr(e.attributes(), "type");
                        page.grid_line_pitch = attr_u32(e.attributes(), "linePitch");
                        page.grid_char_space =
                            attr(e.attributes(), "charSpace").and_then(|v| v.parse().ok());
                    }
                    _ => {}
                }
            }
            Ok(Event::End(e)) => {
                if local(e.name().as_ref()) == b"sectPr" {
                    depth_in_sect = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    page
}

/// 一段 `rPr`/`pPr` 的收集器。进出由调用方按元素边界控制。
#[derive(Default)]
struct BlockCollector {
    info: BlockInfo,
    in_rpr: bool,
    in_ppr: bool,
}

impl BlockCollector {
    fn start(&mut self, name: &[u8], attrs: Attributes) {
        match name {
            b"rPr" => self.in_rpr = true,
            b"pPr" => self.in_ppr = true,
            b"rFonts" if self.in_rpr => {
                self.info.font_east_asia = attr(attrs.clone(), "eastAsia");
                self.info.font_ascii = attr(attrs, "ascii");
            }
            b"sz" if self.in_rpr => self.info.size_half_pt = attr_u32(attrs, "val"),
            b"b" if self.in_rpr => self.info.bold = Some(on_off(attrs)),
            b"jc" if self.in_ppr => self.info.align = attr(attrs, "val"),
            b"spacing" if self.in_ppr => {
                self.info.line = attr_u32(attrs.clone(), "line");
                self.info.line_rule = attr(attrs.clone(), "lineRule");
                self.info.space_before = attr_u32(attrs.clone(), "before");
                self.info.space_after = attr_u32(attrs, "after");
            }
            b"ind" if self.in_ppr => {
                self.info.first_line_chars = attr_u32(attrs.clone(), "firstLineChars");
                self.info.first_line = attr_u32(attrs, "firstLine");
            }
            b"pageBreakBefore" if self.in_ppr => self.info.page_break_before = Some(on_off(attrs)),
            _ => {}
        }
    }

    fn end(&mut self, name: &[u8]) {
        match name {
            b"rPr" => self.in_rpr = false,
            b"pPr" => self.in_ppr = false,
            _ => {}
        }
    }
}

/// `styles.xml` → docDefaults 的正文默认 + Heading1–4。
fn parse_styles(xml: &str) -> (BlockInfo, Vec<Option<BlockInfo>>) {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut defaults = BlockCollector::default();
    let mut headings: Vec<Option<BlockInfo>> = vec![None, None, None, None];

    let mut in_defaults = false;
    // Some(level) 时正在读 HeadingN 的样式体。
    let mut current: Option<(usize, BlockCollector)> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let name = local(e.name().as_ref()).to_vec();
                if name == b"docDefaults" {
                    in_defaults = true;
                } else if name == b"style" {
                    // styleId 认 Heading1..Heading4；Word 自己写的就是这几个 id。
                    if let Some(id) = attr(e.attributes(), "styleId") {
                        if let Some(rest) = id.strip_prefix("Heading") {
                            if let Ok(n) = rest.parse::<usize>() {
                                if (1..=4).contains(&n) {
                                    current = Some((n - 1, BlockCollector::default()));
                                }
                            }
                        }
                    }
                }

                if in_defaults {
                    defaults.start(&name, e.attributes());
                }
                if let Some((_, ref mut c)) = current {
                    c.start(&name, e.attributes());
                }
            }
            Ok(Event::End(e)) => {
                let name = local(e.name().as_ref()).to_vec();
                if in_defaults {
                    defaults.end(&name);
                }
                if let Some((level, ref mut c)) = current {
                    c.end(&name);
                    if name == b"style" {
                        headings[level] = Some(std::mem::take(&mut c.info));
                        current = None;
                    }
                }
                if name == b"docDefaults" {
                    in_defaults = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    (defaults.info, headings)
}

fn read_entry(zip: &mut ZipArchive<Cursor<Vec<u8>>>, name: &str) -> Option<String> {
    let mut file = zip.by_name(name).ok()?;
    let mut out = String::new();
    file.read_to_string(&mut out).ok()?;
    Some(out)
}

pub fn layout_from_bytes(data: Vec<u8>) -> Result<DocxLayout, String> {
    let mut zip = ZipArchive::new(Cursor::new(data))
        .map_err(|_| "这个文件不是有效的 .docx（打不开它的 zip 结构）".to_string())?;

    // 两份都缺才是「读不出来」：只有 styles.xml 的文件仍然能给出正文和标题，
    // 只有 document.xml 的仍然能给出页面。
    let document = read_entry(&mut zip, "word/document.xml");
    let styles = read_entry(&mut zip, "word/styles.xml");
    if document.is_none() && styles.is_none() {
        return Err("这个文件里没有 word/document.xml，不像是 Word 文档".to_string());
    }

    let page = document.as_deref().map(parse_page).unwrap_or_default();
    let (body, headings) = styles
        .as_deref()
        .map(parse_styles)
        .unwrap_or_else(|| (BlockInfo::default(), vec![None, None, None, None]));

    Ok(DocxLayout {
        page,
        body,
        headings,
    })
}

/// 读项目里一份 .docx 的排版参数。
///
/// 走路径而不是字节：文件已经在工作区里，`FsScope` 能为它背书，而把整份文件
/// 搬过 IPC 只为读几十个属性是白搬（同 `pptx_read_slides`）。
#[command]
pub fn docx_read_layout(path: String, scope: State<'_, FsScope>) -> Result<DocxLayout, String> {
    scope.check(&path)?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    layout_from_bytes(bytes)
}

/// 同上，但收字节——作者从系统对话框里挑的模板**在工作区外面**，`FsScope`
/// 不会为它背书，也不该为它背书：授权来自那个原生对话框本身。同
/// `pptx_to_markdown` 的分工（路径给项目内，字节给作者刚挑的文件）。
#[command]
pub fn docx_layout_from_bytes(data: String) -> Result<DocxLayout, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("could not decode the file: {e}"))?;
    layout_from_bytes(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// 手搭一份最小 .docx。不用二进制 fixture：要断言的正是那几个属性，而一个
    /// 不透明的 fixture 恰好会把它们藏起来。
    fn docx(document: &str, styles: &str) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default();
        zip.start_file("word/document.xml", opts).unwrap();
        zip.write_all(document.as_bytes()).unwrap();
        zip.start_file("word/styles.xml", opts).unwrap();
        zip.write_all(styles.as_bytes()).unwrap();
        zip.finish().unwrap().into_inner()
    }

    const GONGWEN_DOC: &str = r#"<?xml version="1.0"?><w:document xmlns:w="w"><w:body>
        <w:p><w:r><w:t>正文</w:t></w:r></w:p>
        <w:sectPr>
          <w:pgSz w:w="11906" w:h="16838"/>
          <w:pgMar w:top="2098" w:right="1474" w:bottom="1984" w:left="1587"/>
          <w:docGrid w:type="linesAndChars" w:linePitch="560" w:charSpace="-4"/>
        </w:sectPr></w:body></w:document>"#;

    const GONGWEN_STYLES: &str = r#"<?xml version="1.0"?><w:styles xmlns:w="w">
        <w:docDefaults><w:rPrDefault><w:rPr>
            <w:rFonts w:ascii="Times New Roman" w:eastAsia="仿宋_GB2312" w:hint="eastAsia"/>
            <w:sz w:val="32"/></w:rPr></w:rPrDefault>
          <w:pPrDefault><w:pPr>
            <w:spacing w:line="560" w:lineRule="exact" w:before="0" w:after="0"/>
            <w:ind w:firstLineChars="200"/><w:jc w:val="both"/></w:pPr></w:pPrDefault>
        </w:docDefaults>
        <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>
          <w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="480"/>
            <w:pageBreakBefore/></w:pPr>
          <w:rPr><w:rFonts w:eastAsia="黑体"/><w:sz w:val="44"/><w:b w:val="false"/></w:rPr>
        </w:style>
        <w:style w:type="paragraph" w:styleId="Heading2">
          <w:rPr><w:rFonts w:eastAsia="楷体_GB2312"/><w:sz w:val="32"/><w:b/></w:rPr>
        </w:style></w:styles>"#;

    #[test]
    fn reads_the_page_setup() {
        let layout = layout_from_bytes(docx(GONGWEN_DOC, GONGWEN_STYLES)).unwrap();
        assert_eq!(layout.page.width, Some(11906));
        assert_eq!(layout.page.margin_top, Some(2098));
        assert_eq!(layout.page.margin_left, Some(1587));
        assert!(!layout.page.landscape);
        assert_eq!(layout.page.grid_type.as_deref(), Some("linesAndChars"));
        assert_eq!(layout.page.grid_line_pitch, Some(560));
        // 公文的字间距本来就是负的——28 个三号字比 156mm 版心宽
        assert_eq!(layout.page.grid_char_space, Some(-4));
    }

    #[test]
    fn reads_the_body_defaults() {
        let layout = layout_from_bytes(docx(GONGWEN_DOC, GONGWEN_STYLES)).unwrap();
        assert_eq!(layout.body.font_east_asia.as_deref(), Some("仿宋_GB2312"));
        assert_eq!(layout.body.font_ascii.as_deref(), Some("Times New Roman"));
        assert_eq!(layout.body.size_half_pt, Some(32));
        assert_eq!(layout.body.line, Some(560));
        // 三态不能混：读出 exact 而不是 auto，是这个字段存在的全部理由
        assert_eq!(layout.body.line_rule.as_deref(), Some("exact"));
        assert_eq!(layout.body.first_line_chars, Some(200));
        assert_eq!(layout.body.align.as_deref(), Some("both"));
    }

    #[test]
    fn reads_each_heading_level_separately() {
        let layout = layout_from_bytes(docx(GONGWEN_DOC, GONGWEN_STYLES)).unwrap();
        let h1 = layout.headings[0].as_ref().unwrap();
        assert_eq!(h1.font_east_asia.as_deref(), Some("黑体"));
        assert_eq!(h1.size_half_pt, Some(44));
        assert_eq!(h1.align.as_deref(), Some("center"));
        assert_eq!(h1.bold, Some(false));
        assert_eq!(h1.page_break_before, Some(true));
        assert_eq!(h1.space_after, Some(480));

        let h2 = layout.headings[1].as_ref().unwrap();
        assert_eq!(h2.font_east_asia.as_deref(), Some("楷体_GB2312"));
        // `<w:b/>` 不带 val 就是「开」——OOXML 的 on/off 约定
        assert_eq!(h2.bold, Some(true));

        // 文件里没声明的层级是 None，不是一份空壳：调用方要能分辨「没写死」和
        // 「写死成了默认值」。
        assert!(layout.headings[2].is_none());
        assert!(layout.headings[3].is_none());
    }

    #[test]
    fn the_last_sect_pr_wins() {
        // 分节符会让文件里出现多个 sectPr；整篇的页面设置是 body 末尾那个。
        let doc = r#"<?xml version="1.0"?><w:document xmlns:w="w"><w:body>
            <w:p><w:pPr><w:sectPr><w:pgSz w:w="1" w:h="2"/></w:sectPr></w:pPr></w:p>
            <w:sectPr><w:pgSz w:w="11906" w:h="16838" w:orient="portrait"/></w:sectPr>
        </w:body></w:document>"#;
        let layout = layout_from_bytes(docx(doc, GONGWEN_STYLES)).unwrap();
        assert_eq!(layout.page.width, Some(11906));
    }

    #[test]
    fn landscape_is_read_from_the_orient_attribute() {
        let doc = r#"<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:sectPr>
            <w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr></w:body></w:document>"#;
        let layout = layout_from_bytes(docx(doc, GONGWEN_STYLES)).unwrap();
        assert!(layout.page.landscape);
    }

    #[test]
    fn a_file_that_declares_nothing_reads_as_all_none() {
        // 全用 Word 默认值的文件不是错误——它只是没写死任何东西，调用方要能
        // 把这件事告诉作者，而不是报一个假的规格。
        let doc = r#"<?xml version="1.0"?><w:document xmlns:w="w"><w:body></w:body></w:document>"#;
        let styles = r#"<?xml version="1.0"?><w:styles xmlns:w="w"></w:styles>"#;
        let layout = layout_from_bytes(docx(doc, styles)).unwrap();
        assert_eq!(layout.body, BlockInfo::default());
        assert_eq!(layout.page, PageInfo::default());
        assert!(layout.headings.iter().all(|h| h.is_none()));
    }

    #[test]
    fn a_non_zip_is_refused_by_name() {
        let err = layout_from_bytes(b"this is not a zip".to_vec()).unwrap_err();
        assert!(err.contains(".docx"));
    }
}
