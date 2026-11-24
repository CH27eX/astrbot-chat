"""把项目里的 Markdown 文档转成带样式的 Word（.docx）。

只覆盖这些文档实际用到的语法：标题、段落、无序/有序列表、表格、代码块、引用、
加粗、行内代码、链接（保留文字）。够用即可，不是通用转换器。

用法：
    python scripts/md-to-docx.py docs/安装配置指南-0.2.26.md out.docx
    python scripts/md-to-docx.py --pdf docs/xxx.md out.docx     # 有 Word 时顺手导 PDF
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

BODY_FONT = "微软雅黑"
CODE_FONT = "Consolas"
ACCENT = RGBColor(0x2F, 0x6B, 0xE0)
MUTED = RGBColor(0x5A, 0x61, 0x70)
CODE_BG = "F4F5F7"
HEADER_BG = "EAF0FB"
QUOTE_BG = "F7F8FA"

INLINE = re.compile(r"(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))")


def set_cell_shading(cell, hex_fill: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    tc_pr.append(shd)


def set_paragraph_shading(paragraph, hex_fill: str) -> None:
    p_pr = paragraph._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    p_pr.append(shd)


def set_run_font(run, name: str, size: float | None = None, bold: bool | None = None) -> None:
    run.font.name = name
    r_pr = run._element.get_or_add_rPr()
    r_fonts = r_pr.find(qn("w:rFonts"))
    if r_fonts is None:
        r_fonts = OxmlElement("w:rFonts")
        r_pr.append(r_fonts)
    r_fonts.set(qn("w:ascii"), name)
    r_fonts.set(qn("w:hAnsi"), name)
    r_fonts.set(qn("w:eastAsia"), name)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold


def add_inline(
    paragraph,
    text: str,
    size: float = 10.5,
    color: RGBColor | None = None,
    bold: bool = False,
) -> None:
    # 先拆加粗，再在每一段里拆行内代码 / 链接：`**scope 勾 `chat`**` 这种嵌套才不会漏
    for part in re.split(r"(\*\*[^*]+\*\*)", text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            add_inline(paragraph, part[2:-2], size, color, bold=True)
            continue
        for chunk in re.split(r"(`[^`]+`|\[[^\]]+\]\([^)]+\))", part):
            if not chunk:
                continue
            if chunk.startswith("`") and chunk.endswith("`") and len(chunk) > 2:
                run = paragraph.add_run(chunk[1:-1])
                set_run_font(run, CODE_FONT, size - 1, bold=bold)
                run.font.color.rgb = RGBColor(0xC7, 0x2E, 0x4A)
                continue
            if chunk.startswith("[") and "](" in chunk:
                label = chunk[1 : chunk.index("]")]
                run = paragraph.add_run(label)
                set_run_font(run, BODY_FONT, size, bold=bold)
                run.font.underline = True
                run.font.color.rgb = ACCENT
                continue
            run = paragraph.add_run(chunk)
            set_run_font(run, BODY_FONT, size, bold=bold)
            if color is not None:
                run.font.color.rgb = color


def add_code_block(doc: Document, lines: list[str]) -> None:
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.space_before = Pt(4)
    paragraph.paragraph_format.space_after = Pt(8)
    paragraph.paragraph_format.left_indent = Cm(0.3)
    paragraph.paragraph_format.line_spacing = 1.15
    set_paragraph_shading(paragraph, CODE_BG)
    run = paragraph.add_run("\n".join(lines))
    set_run_font(run, CODE_FONT, 9)
    run.font.color.rgb = RGBColor(0x24, 0x29, 0x2F)


def add_table(doc: Document, rows: list[list[str]]) -> None:
    header, *body = rows
    table = doc.add_table(rows=1, cols=len(header))
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for index, text in enumerate(header):
        cell = table.rows[0].cells[index]
        cell.text = ""
        paragraph = cell.paragraphs[0]
        add_inline(paragraph, text, size=9.5)
        for run in paragraph.runs:
            run.font.bold = True
        set_cell_shading(cell, HEADER_BG)
    for row in body:
        cells = table.add_row().cells
        for index, text in enumerate(row[: len(header)]):
            cells[index].text = ""
            add_inline(cells[index].paragraphs[0], text, size=9.5)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def split_row(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def convert(md_path: Path, docx_path: Path) -> None:
    lines = md_path.read_text(encoding="utf-8").splitlines()
    doc = Document()

    section = doc.sections[0]
    section.page_width = Cm(21)
    section.page_height = Cm(29.7)
    section.left_margin = Cm(2.2)
    section.right_margin = Cm(2.2)
    section.top_margin = Cm(2.0)
    section.bottom_margin = Cm(2.0)

    normal = doc.styles["Normal"]
    normal.font.name = BODY_FONT
    normal.font.size = Pt(10.5)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)
    normal.paragraph_format.line_spacing = 1.45
    normal.paragraph_format.space_after = Pt(6)

    # 页脚页码
    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = footer.add_run()
    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), "PAGE")
    footer._p.append(fld)

    index = 0
    first_heading = True
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()

        if stripped.startswith("```"):
            index += 1
            code: list[str] = []
            while index < len(lines) and not lines[index].strip().startswith("```"):
                code.append(lines[index])
                index += 1
            add_code_block(doc, code)
            index += 1
            continue

        if stripped.startswith("|") and index + 1 < len(lines) and re.match(r"^\|[\s:\-|]+\|$", lines[index + 1].strip()):
            rows = [split_row(stripped)]
            index += 2
            while index < len(lines) and lines[index].strip().startswith("|"):
                rows.append(split_row(lines[index]))
                index += 1
            add_table(doc, rows)
            continue

        if stripped.startswith("#"):
            level = len(stripped) - len(stripped.lstrip("#"))
            text = stripped[level:].strip()
            if level == 1 and first_heading:
                paragraph = doc.add_paragraph()
                paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
                add_inline(paragraph, text, size=24)
                for run in paragraph.runs:
                    run.font.bold = True
                    run.font.color.rgb = RGBColor(0x11, 0x16, 0x1F)
                first_heading = False
                index += 1
                continue
            heading = doc.add_heading(level=min(level + (1 if first_heading else 0), 4))
            heading.text = ""
            run = heading.add_run(text)
            set_run_font(run, BODY_FONT, {1: 18, 2: 15, 3: 12.5, 4: 11.5}.get(level, 11), bold=True)
            run.font.color.rgb = RGBColor(0x11, 0x16, 0x1F) if level <= 2 else ACCENT
            heading.paragraph_format.space_before = Pt(14 if level <= 2 else 10)
            heading.paragraph_format.space_after = Pt(6)
            index += 1
            continue

        if stripped == "---" or stripped == "***":
            paragraph = doc.add_paragraph()
            p_pr = paragraph._p.get_or_add_pPr()
            border = OxmlElement("w:pBdr")
            bottom = OxmlElement("w:bottom")
            bottom.set(qn("w:val"), "single")
            bottom.set(qn("w:sz"), "6")
            bottom.set(qn("w:color"), "D8DDE6")
            border.append(bottom)
            p_pr.append(border)
            index += 1
            continue

        if stripped.startswith(">"):
            text = stripped.lstrip(">").strip()
            paragraph = doc.add_paragraph()
            paragraph.paragraph_format.left_indent = Cm(0.4)
            set_paragraph_shading(paragraph, QUOTE_BG)
            add_inline(paragraph, text, size=9.5, color=MUTED)
            index += 1
            continue

        ordered = re.match(r"^(\d+)\.\s+(.*)$", stripped)
        if stripped.startswith("- ") or stripped.startswith("* "):
            paragraph = doc.add_paragraph(style="List Bullet")
            paragraph.paragraph_format.space_after = Pt(2)
            add_inline(paragraph, stripped[2:].strip())
            index += 1
            continue
        if ordered:
            paragraph = doc.add_paragraph()
            paragraph.paragraph_format.left_indent = Cm(0.8)
            paragraph.paragraph_format.first_line_indent = Cm(-0.55)
            paragraph.paragraph_format.space_after = Pt(2)
            add_inline(paragraph, f"{ordered.group(1)}. {ordered.group(2)}")
            index += 1
            continue

        if not stripped:
            index += 1
            continue

        paragraph = doc.add_paragraph()
        add_inline(paragraph, stripped)
        index += 1

    docx_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(docx_path)
    print(f"docx: {docx_path}")


def to_pdf(docx_path: Path) -> None:
    """有 Microsoft Word 时用 COM 导一份 PDF（没有就跳过）。"""
    try:
        import win32com.client as win32  # type: ignore
    except Exception:
        print("跳过 PDF：没装 pywin32（pip install pywin32）")
        return
    word = win32.Dispatch("Word.Application")
    word.Visible = False
    try:
        document = word.Documents.Open(str(docx_path))
        pdf_path = docx_path.with_suffix(".pdf")
        document.SaveAs(str(pdf_path), FileFormat=17)
        document.Close(False)
        print(f"pdf:  {pdf_path}")
    finally:
        word.Quit()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--pdf", action="store_true")
    args = parser.parse_args()

    if not args.source.exists():
        print(f"找不到源文件：{args.source}", file=sys.stderr)
        return 1
    convert(args.source, args.target)
    if args.pdf:
        to_pdf(args.target.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
