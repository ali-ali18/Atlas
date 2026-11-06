/**
 * Script Python (python-pptx) que a sandbox `run_code` executa para preencher o modelo do usuário.
 * É código nosso, fixo: o modelo nunca escreve nem altera este script. Entradas em `in/`: `template.pptx`
 * (já validado e normalizado pelo servidor) e `job.zip` (`job.json` com o plano + `assets/*`). Saída em
 * `out/deck.pptx`; as páginas renderizadas pelo LibreOffice vão para `preview/`.
 *
 * Mantenha sem crases e sem `${` (vive dentro de um template literal).
 */
export const TEMPLATE_FILL_SCRIPT = String.raw`
import copy, io, json, os, re, subprocess, sys, zipfile
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION, XL_LABEL_POSITION
from pptx.enum.dml import MSO_THEME_COLOR
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE, PP_PLACEHOLDER
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt
from lxml import etree
from PIL import Image

W = os.environ.get("ATLAS_WORK", "/work")
A = "http://schemas.openxmlformats.org/drawingml/2006/main"

TOKENS = {
    "accent": (MSO_THEME_COLOR.ACCENT_1, 0),
    "accent2": (MSO_THEME_COLOR.ACCENT_2, 0),
    "text": (MSO_THEME_COLOR.TEXT_1, 0),
    "muted": (MSO_THEME_COLOR.TEXT_1, 0.4),
    "surface": (MSO_THEME_COLOR.BACKGROUND_1, -0.05),
    "bg": (MSO_THEME_COLOR.BACKGROUND_1, 0),
    "border": (MSO_THEME_COLOR.BACKGROUND_1, -0.18),
    "on_accent": (MSO_THEME_COLOR.BACKGROUND_1, 0),
}
HEX = re.compile(r"^#?[0-9a-fA-F]{6}$")


def set_color(fmt, value):
    value = value or "text"
    if HEX.match(value):
        fmt.rgb = RGBColor.from_string(value.lstrip("#").upper())
        return
    theme, bright = TOKENS.get(value, TOKENS["text"])
    fmt.theme_color = theme
    if bright:
        fmt.brightness = bright


def add_alpha(shape, opacity):
    if opacity is None or opacity >= 1:
        return
    sp_pr = shape._element.spPr
    fill = sp_pr.find(qn("a:solidFill"))
    if fill is None or len(fill) == 0:
        return
    alpha = etree.SubElement(fill[0], qn("a:alpha"))
    alpha.set("val", str(int(round(opacity * 100000))))


def drop_slides(prs):
    ids = prs.slides._sldIdLst
    for sld in list(ids):
        prs.part.drop_rel(sld.rId)
        ids.remove(sld)


def set_text(tf, lines, size=None, color=None, bold=None, italic=None, font=None, align=None, bullets=False):
    tf.clear()
    first = True
    for line in lines:
        text = line["text"] if isinstance(line, dict) else line
        level = line.get("level", 0) if isinstance(line, dict) else 0
        p = tf.paragraphs[0] if first else tf.add_paragraph()
        first = False
        if level:
            p.level = min(int(level), 4)
        if align:
            p.alignment = align
        run = p.add_run()
        run.text = text
        f = run.font
        if size:
            f.size = Pt(size)
        if bold or (isinstance(line, dict) and line.get("bold")):
            f.bold = True
        if italic:
            f.italic = True
        if font:
            f.name = font
        if color:
            set_color(f.color, color)
        if bullets:
            p_pr = p._p.get_or_add_pPr()
            p_pr.set("marL", str(int(Inches(0.28))))
            p_pr.set("indent", str(-int(Inches(0.28))))
            for tag in ("a:buNone", "a:buChar", "a:buFont"):
                for old in p_pr.findall(qn(tag)):
                    p_pr.remove(old)
            bu_font = etree.SubElement(p_pr, qn("a:buFont"))
            bu_font.set("typeface", "Arial")
            bu = etree.SubElement(p_pr, qn("a:buChar"))
            bu.set("char", "•")


def draw_text(slide, el):
    tb = slide.shapes.add_textbox(Inches(el["x"]), Inches(el["y"]), Inches(el["w"]), Inches(el["h"]))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = {"top": MSO_ANCHOR.TOP, "middle": MSO_ANCHOR.MIDDLE, "bottom": MSO_ANCHOR.BOTTOM}[el.get("valign", "top")]
    align = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}[el.get("align", "left")]
    lines = [t for t in el["text"].split("\n") if t.strip()] if el.get("bullets") else el["text"].split("\n")
    font = "+mj-lt" if el.get("font") == "heading" else "+mn-lt"
    set_text(tf, lines, size=el.get("size", 18), color=el.get("color", "text"), bold=el.get("bold"), italic=el.get("italic"), font=font, align=align, bullets=el.get("bullets", False))
    tf.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE


SHAPES = {"rect": MSO_SHAPE.RECTANGLE, "rounded_rect": MSO_SHAPE.ROUNDED_RECTANGLE, "circle": MSO_SHAPE.OVAL}


def draw_shape(slide, el):
    kind = el.get("shape", "rect")
    if kind in ("line", "arrow"):
        conn = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(el["x"]), Inches(el["y"]), Inches(el["x"] + el["w"]), Inches(el["y"] + el["h"]))
        set_color(conn.line.color, el.get("stroke") or el.get("fill") or "accent")
        conn.line.width = Pt(el.get("strokeWidth", 2))
        if kind == "arrow":
            ln = conn.line._get_or_add_ln()
            tail = etree.SubElement(ln, qn("a:tailEnd"))
            tail.set("type", "triangle")
        return
    shape = slide.shapes.add_shape(SHAPES[kind], Inches(el["x"]), Inches(el["y"]), Inches(el["w"]), Inches(el["h"]))
    if kind == "rounded_rect":
        shape.adjustments[0] = 0.15
    if el.get("fill"):
        shape.fill.solid()
        set_color(shape.fill.fore_color, el["fill"])
        add_alpha(shape, el.get("opacity"))
    else:
        shape.fill.background()
    if el.get("stroke"):
        set_color(shape.line.color, el["stroke"])
        shape.line.width = Pt(el.get("strokeWidth", 1))
    else:
        shape.line.fill.background()
    shape.shadow.inherit = False
    if el.get("text"):
        tf = shape.text_frame
        tf.word_wrap = True
        tf.vertical_anchor = MSO_ANCHOR.MIDDLE
        tf.margin_left = tf.margin_right = Inches(0.08)
        set_text(tf, [el["text"]], size=el.get("textSize", 18), color=el.get("textColor", "on_accent" if el.get("fill") else "text"), bold=el.get("textBold"), font="+mn-lt", align=PP_ALIGN.CENTER)
        tf.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE


def fit_picture(slide, data, el):
    img = Image.open(io.BytesIO(data))
    iw, ih = img.size
    x, y, w, h = el["x"], el["y"], el["w"], el["h"]
    if el.get("fit") == "cover":
        pic = slide.shapes.add_picture(io.BytesIO(data), Inches(x), Inches(y), Inches(w), Inches(h))
        box_ratio, img_ratio = w / h, iw / ih
        if img_ratio > box_ratio:
            crop = (1 - box_ratio / img_ratio) / 2
            pic.crop_left = pic.crop_right = crop
        elif img_ratio < box_ratio:
            crop = (1 - img_ratio / box_ratio) / 2
            pic.crop_top = pic.crop_bottom = crop
    else:
        scale = min(w / iw, h / ih)
        pw, ph = iw * scale, ih * scale
        pic = slide.shapes.add_picture(io.BytesIO(data), Inches(x + (w - pw) / 2), Inches(y + (h - ph) / 2), Inches(pw), Inches(ph))
    if el.get("alt"):
        pic._element.nvPicPr.cNvPr.set("descr", el["alt"])
    return pic


def draw_chart(slide, el):
    data = CategoryChartData()
    data.categories = el["labels"]
    for s in el["series"]:
        data.add_series(s["name"], s["values"])
    kind, stacked, horiz = el["kind"], el.get("stacked"), el.get("horizontal")
    if kind == "pie":
        ctype = XL_CHART_TYPE.PIE
    elif kind == "line":
        ctype = XL_CHART_TYPE.LINE_MARKERS
    elif kind == "area":
        ctype = XL_CHART_TYPE.AREA_STACKED if stacked else XL_CHART_TYPE.AREA
    elif horiz:
        ctype = XL_CHART_TYPE.BAR_STACKED if stacked else XL_CHART_TYPE.BAR_CLUSTERED
    else:
        ctype = XL_CHART_TYPE.COLUMN_STACKED if stacked else XL_CHART_TYPE.COLUMN_CLUSTERED
    gframe = slide.shapes.add_chart(ctype, Inches(el["x"]), Inches(el["y"]), Inches(el["w"]), Inches(el["h"]), data)
    chart = gframe.chart
    chart.has_title = False
    chart.font.size = Pt(12)
    many = len(el["series"]) > 1
    chart.has_legend = many or kind == "pie"
    if chart.has_legend:
        chart.legend.position = XL_LEGEND_POSITION.RIGHT if kind == "pie" else XL_LEGEND_POSITION.BOTTOM
        chart.legend.include_in_layout = False
    plot = chart.plots[0]
    fmt = el.get("numberFormat")
    if kind == "pie":
        plot.has_data_labels = True
        plot.data_labels.show_percentage = True
        plot.data_labels.show_value = False
        plot.data_labels.number_format = "0%"
        plot.data_labels.number_format_is_linked = False
        return
    if len(el["labels"]) <= 12 and not stacked and not many and kind != "area":
        plot.has_data_labels = True
        plot.data_labels.number_format = fmt or "General"
        plot.data_labels.number_format_is_linked = False
        if kind == "bar":
            plot.data_labels.position = XL_LABEL_POSITION.OUTSIDE_END
    if fmt:
        chart.value_axis.tick_labels.number_format = fmt
        chart.value_axis.tick_labels.number_format_is_linked = False
    chart.value_axis.has_major_gridlines = True


def draw_table(slide, el):
    rows, cols = len(el["rows"]) + 1, len(el["columns"])
    gframe = slide.shapes.add_table(rows, cols, Inches(el["x"]), Inches(el["y"]), Inches(el["w"]), Inches(el["h"]))
    table = gframe.table
    size = el.get("size", 14)
    for c, name in enumerate(el["columns"]):
        cell = table.cell(0, c)
        cell.text = name
        for p in cell.text_frame.paragraphs:
            for r in p.runs:
                r.font.size = Pt(size)
                r.font.bold = True
    for r, row in enumerate(el["rows"], start=1):
        for c, value in enumerate(row):
            cell = table.cell(r, c)
            cell.text = value
            for p in cell.text_frame.paragraphs:
                if el["align"][c] == "right":
                    p.alignment = PP_ALIGN.RIGHT
                for run in p.runs:
                    run.font.size = Pt(size)
                    run.font.bold = c == 0
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
    for i in range(rows):
        table.rows[i].height = Emu(int(Inches(el["h"]) / rows))


def draw_background(prs, slide, plan, assets):
    bg = plan.get("background")
    if not bg:
        return
    if bg["kind"] == "color":
        slide.background.fill.solid()
        set_color(slide.background.fill.fore_color, bg["color"])
        return
    data = assets[bg["asset"]]
    sw, sh = Emu(prs.slide_width).inches, Emu(prs.slide_height).inches
    pic = fit_picture(slide, data, {"x": 0, "y": 0, "w": sw, "h": sh, "fit": "cover"})
    tree = slide.shapes._spTree
    tree.remove(pic._element)
    tree.insert(2, pic._element)
    scrim = bg.get("scrim")
    if scrim:
        rect = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height)
        rect.fill.solid()
        set_color(rect.fill.fore_color, scrim["color"])
        add_alpha(rect, scrim["opacity"])
        rect.line.fill.background()
        rect.shadow.inherit = False
        tree.remove(rect._element)
        tree.insert(3, rect._element)


def fill_placeholders(slide, plan):
    filled = set()
    by_idx = {ph.placeholder_format.idx: ph for ph in slide.placeholders}
    for fill in plan["fills"]:
        ph = by_idx.get(fill["idx"])
        if ph is None or not ph.has_text_frame or not fill["lines"]:
            continue
        filled.add(fill["idx"])
        tf = ph.text_frame
        set_text(tf, fill["lines"], color=plan.get("ink"))
        if ph.placeholder_format.type not in (PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE):
            tf.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
    for ph in list(slide.placeholders):
        if ph.placeholder_format.idx not in filled:
            ph._element.getparent().remove(ph._element)


def keep_slide_number(slide, layout):
    for ph in layout.placeholders:
        if ph.placeholder_format.type == PP_PLACEHOLDER.SLIDE_NUMBER:
            slide.shapes._spTree.append(copy.deepcopy(ph._element))


def main():
    job_zip = zipfile.ZipFile(os.path.join(W, "in", "job.zip"))
    job = json.loads(job_zip.read("job.json"))
    assets = {name[len("assets/"):]: job_zip.read(name) for name in job_zip.namelist() if name.startswith("assets/")}
    prs = Presentation(os.path.join(W, "in", "template.pptx"))
    drop_slides(prs)
    masters = list(prs.slide_masters)
    for number, plan in enumerate(job["slides"], start=1):
        layout = masters[plan["master"]].slide_layouts[plan["layout"]]
        slide = prs.slides.add_slide(layout)
        fill_placeholders(slide, plan)
        keep_slide_number(slide, layout)
        draw_background(prs, slide, plan, assets)
        for el in plan["elements"]:
            kind = el["type"]
            if kind == "text":
                draw_text(slide, el)
            elif kind == "shape":
                draw_shape(slide, el)
            elif kind == "picture":
                fit_picture(slide, assets[el["asset"]], el)
            elif kind == "chart":
                draw_chart(slide, el)
            elif kind == "table":
                draw_table(slide, el)
        if plan.get("notes"):
            slide.notes_slide.notes_text_frame.text = plan["notes"]
    os.makedirs(os.path.join(W, "out"), exist_ok=True)
    out = os.path.join(W, "out", "deck.pptx")
    prs.save(out)
    print("FILLED slides=%d" % len(job["slides"]))
    if job.get("preview", True):
        render_preview(out)


def render_preview(path):
    pdf_dir = os.path.join("/tmp", "deck-pdf")
    prev = os.path.join(W, "preview")
    os.makedirs(pdf_dir, exist_ok=True)
    os.makedirs(prev, exist_ok=True)
    try:
        subprocess.run(["soffice", "--headless", "--norestore", "-env:UserInstallation=file:///tmp/lo-deck", "--convert-to", "pdf", "--outdir", pdf_dir, path], check=True, timeout=80, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        pdf = os.path.join(pdf_dir, "deck.pdf")
        subprocess.run(["pdftoppm", "-r", "55", "-l", "12", "-png", pdf, os.path.join(prev, "slide")], check=True, timeout=60)
        print("PREVIEW pages=%d" % len([n for n in os.listdir(prev) if n.endswith(".png")]))
    except Exception as exc:
        print("PREVIEW_SKIPPED %s" % type(exc).__name__)


main()
`;
