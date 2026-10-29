#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Python Report Engine for cost-control-system.

Reads a JSON request from stdin, writes a JSON response to stdout.
No external dependencies. No eval. All operations are whitelisted.
"""
import json
import sys
import html as _html

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

ALLOWED_AGGS = {"sum", "avg", "count", "min", "max"}
ALLOWED_COMPONENTS = {"kpi", "table", "bar", "line", "pie", "heading", "text", "divider", "shape"}

# فلاتر البيانات على مستوى التقرير (تُطبَّق على الصفوف قبل التصيير)
ALLOWED_FILTER_OPS = {">", ">=", "<", "<=", "==", "!=", "contains", "startsWith", "in", "notEmpty", "empty"}
MAX_FILTERS = 10
ALLOWED_RULE_OPS = {">", ">=", "<", "<=", "==", "!="}
MAX_ROWS = 5000
MAX_COMPONENTS = 50
MAX_RULES = 10
GRID_COLUMNS = 12

# --- قيم النمط: قوائم بيضاء صارمة (لا حقن CSS ولا تنفيذ كود) ---
_HEX_RE = __import__("re").compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_RGB_RE = __import__("re").compile(r"^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$")
_BORDER_RE = __import__("re").compile(
    r"^(?:none|(?:\d{1,3}(?:px|pt|em|rem|%)\s+)?(?:solid|dashed|dotted|double)\s+"
    r"(?:#[0-9a-fA-F]{3,8}|rgba?\([\d\s,.%]+\)|[a-z]+)"
    r"(?:\s+(?:\d{1,3}(?:px|pt|em|rem|%)\s+)?(?:#[0-9a-fA-F]{3,8}|rgba?\([\d\s,.%]+\)|[a-z]+))?)$")


def safe_color(v):
    """لون آمن: hex أو rgb(a) فقط — يُتجاهل أي شيء آخر."""
    s = str(v if v is not None else "").strip()
    if _HEX_RE.match(s) or _RGB_RE.match(s):
        return s
    return ""


def safe_border(v):
    """حد CSS آمن (قائمة بيضاء) — يُتجاهل أي شيء آخر."""
    s = str(v if v is not None else "").strip()
    if _BORDER_RE.match(s):
        return s
    return ""


def clamp_int(v, lo, hi, default):
    try:
        n = int(v)
    except (ValueError, TypeError):
        return default
    return max(lo, min(hi, n))


def normalize_style(comp):
    """نمط العنصر بعد التنقية — القيم غير الصالحة تُسقط بصمت."""
    s = comp.get("style")
    if not isinstance(s, dict):
        return {}
    out = {}
    bg = safe_color(s.get("bg"))
    if bg:
        out["bg"] = bg
    color = safe_color(s.get("color"))
    if color:
        out["color"] = color
    accent = safe_color(s.get("accent"))
    if accent:
        out["accent"] = accent
    border = safe_border(s.get("border"))
    if border:
        out["border"] = border
    if s.get("radius") is not None:
        out["radius"] = clamp_int(s.get("radius"), 0, 40, 12)
    if s.get("fontSize") is not None:
        out["fontSize"] = clamp_int(s.get("fontSize"), 8, 72, 0)
    weight = str(s.get("fontWeight") or "").strip().lower()
    if weight in ("normal", "bold", "lighter") or (weight.isdigit() and weight in ("100", "200", "300", "400", "500", "600", "700", "800", "900")):
        out["fontWeight"] = weight
    align = str(s.get("align") or "").strip()
    if align in ("start", "center", "end", "justify"):
        out["align"] = align
    if s.get("padding") is not None:
        out["padding"] = clamp_int(s.get("padding"), 0, 48, 12)
    if s.get("shadow"):
        out["shadow"] = True
    return out


def style_css(comp):
    """سلسلة CSS سطرية من النمط المُنقّى (آمنة — لا مدخلات حرة)."""
    st = normalize_style(comp)
    out = []
    if st.get("bg"):
        out.append("background:" + st["bg"])
    if st.get("color"):
        out.append("color:" + st["color"])
    if st.get("border"):
        out.append("border:" + st["border"])
    if st.get("radius") is not None:
        out.append("border-radius:%dpx" % st["radius"])
    if st.get("fontSize"):
        out.append("font-size:%dpx" % st["fontSize"])
    if st.get("fontWeight"):
        out.append("font-weight:" + st["fontWeight"])
    if st.get("align"):
        out.append("text-align:" + st["align"])
    if st.get("padding") is not None:
        out.append("padding:%dpx" % st["padding"])
    if st.get("shadow"):
        out.append("box-shadow:0 8px 22px rgba(0,0,0,.28)")
    if st.get("accent"):
        out.append("border-color:" + st["accent"])
    return ";".join(out)


def grid_css(comp, layout_columns):
    """موضع العنصر في شبكة الأعمدة. بلا grid ⇒ عرض كامل (توافق مع التقارير القديمة)."""
    g = comp.get("grid")
    if not isinstance(g, dict):
        return "grid-column:span %d" % layout_columns
    w = clamp_int(g.get("w"), 1, layout_columns, layout_columns)
    h = clamp_int(g.get("h"), 1, 6, 1)
    return "grid-column:span %d;min-height:%dpx" % (w, h * 64)


def normalize_rules(comp):
    rules = comp.get("rules")
    if not isinstance(rules, list):
        return []
    out = []
    for r in rules[:MAX_RULES]:
        if not isinstance(r, dict):
            continue
        column = str(r.get("column") or "").strip()
        if not column:
            continue
        op = str(r.get("op") or ">")
        if op not in ALLOWED_RULE_OPS:
            op = ">"
        rule = {"column": column, "op": op}
        if r.get("value") is not None:
            rule["value"] = r.get("value")
        color = safe_color(r.get("color"))
        if color:
            rule["color"] = color
        bg = safe_color(r.get("bg"))
        if bg:
            rule["bg"] = bg
        out.append(rule)
    return out


def normalize_filters(filters):
    """فلاتر التقرير — قائمة بيضاء (عمود · عملية · قيمة) مع تجاهل غير الصالح."""
    if not isinstance(filters, list):
        return []
    out = []
    for f in filters[:MAX_FILTERS]:
        if not isinstance(f, dict):
            continue
        column = str(f.get("column") or "").strip()
        if not column:
            continue
        op = str(f.get("op") or "==").strip()
        if op not in ALLOWED_FILTER_OPS:
            continue
        item = {"column": column, "op": op}
        if f.get("value") is not None:
            item["value"] = f.get("value")
        out.append(item)
    return out


def filter_match(f, row):
    """مطابقة فلتر واحد على صف (مقارنة نصية/رقمية/تاريخية)."""
    if not isinstance(row, dict):
        return False
    v = row.get(f.get("column"))
    op = f.get("op", "==")
    t = f.get("value")
    if op == "empty":
        return v is None or v == ""
    if op == "notEmpty":
        return v is not None and v != ""
    if op == "contains":
        return ("" if v is None else str(v)).find(str(t if t is not None else "")) >= 0
    if op == "startsWith":
        return ("" if v is None else str(v)).startswith(str(t if t is not None else ""))
    if op == "in":
        vals = t if isinstance(t, list) else str(t if t is not None else "").split(",")
        vals = [str(x).strip() for x in vals if str(x).strip() != ""]
        return str(v) in vals
    vn = to_num(v)
    tn = to_num(t)
    if vn is None or tn is None:
        sv = "" if v is None else str(v)
        st = "" if t is None else str(t)
        if op == "==":
            return sv == st
        if op == "!=":
            return sv != st
        return False
    if op == ">":
        return vn > tn
    if op == ">=":
        return vn >= tn
    if op == "<":
        return vn < tn
    if op == "<=":
        return vn <= tn
    if op == "==":
        return vn == tn
    if op == "!=":
        return vn != tn
    return False


def apply_filters(rows, filters):
    """تطبيق فلاتر التقرير على الصفوف — يعيد (الصفوف المفلترة · عدد المستبعد)."""
    fs = normalize_filters(filters)
    if not fs:
        return rows, 0
    kept = [r for r in rows if all(filter_match(f, r) for f in fs)]
    return kept, len(rows) - len(kept)


def rule_matches(rule, value):
    """هل تحقق الشرط على قيمة عددية؟"""
    v = to_num(value)
    t = to_num(rule.get("value"))
    if v is None or t is None:
        return False
    op = rule.get("op", ">")
    if op == ">":
        return v > t
    if op == ">=":
        return v >= t
    if op == "<":
        return v < t
    if op == "<=":
        return v <= t
    if op == "==":
        return v == t
    if op == "!=":
        return v != t
    return False


def rule_style(rule):
    """CSS تنسيق شرطي مطابق (خلفية/لون)."""
    parts = []
    if rule.get("bg"):
        parts.append("background:" + rule["bg"])
    if rule.get("color"):
        parts.append("color:" + rule["color"])
    return ";".join(parts)


def to_num(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).strip())
    except (ValueError, TypeError):
        return None

def agg_values(vals, agg):
    nums = [x for x in (to_num(v) for v in vals) if x is not None]
    if agg == "count":
        return len(vals)
    if not nums:
        return None
    if agg == "sum":
        return sum(nums)
    if agg == "avg":
        return sum(nums) / len(nums)
    if agg == "min":
        return min(nums)
    if agg == "max":
        return max(nums)
    return None

def aggregate(rows, key_col, val_col, agg):
    groups = {}
    order = []
    for r in rows:
        k = r.get(key_col)
        key = "" if k is None else str(k)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(r.get(val_col))
    out = []
    for k in order:
        out.append({"label": k, "value": agg_values(groups[k], agg)})
    # sort by value desc for charts (stable: keep original order on ties)
    return out

def fmt(v, decimals=None):
    if v is None:
        return "\u2014"
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, (int, float)):
        if decimals is None:
            decimals = 0 if (isinstance(v, int) or (isinstance(v, float) and v == int(v) and abs(v) < 1e15)) else 2
        try:
            decimals = max(0, min(6, int(decimals)))
        except (ValueError, TypeError):
            decimals = 2
        if decimals == 0:
            return f"{int(round(v)):,}"
        return f"{v:,.{decimals}f}"
    return str(v)

def esc(s):
    return _html.escape(str(s), quote=True)

def component_required_columns(comp):
    """الأعمدة التي يحتاجها المكوّن للحساب — تُشتق من تعريفه فقط (لا من البيانات)."""
    t = comp.get("type")
    if t == "kpi":
        return [comp.get("column")] if comp.get("column") else []
    if t == "table":
        need = [c for c in (comp.get("columns") or [])]
        if comp.get("sort"):
            need.append(comp.get("sort"))
        for r in (comp.get("rules") or []):
            if isinstance(r, dict) and r.get("column"):
                need.append(r.get("column"))
        return need
    if t in ("bar", "line", "pie"):
        return [comp.get("category"), comp.get("value")]
    return []


def component_missing_columns(comp, columns):
    """الأعمدة المطلوبة للمكوّن وغير الموجودة في بيانات المصدر."""
    if not isinstance(columns, list):
        return []
    have = set(str(c) for c in columns)
    missing = []
    for c in component_required_columns(comp):
        if c is None or c == "":
            continue
        if str(c) not in have and str(c) not in missing:
            missing.append(str(c))
    return missing


def component_name(comp):
    """اسم بشري للمكوّن — من تعريفه فقط (لا قيم صفوف ولا استعلامات)."""
    for k in ("label", "title", "text"):
        v = comp.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()[:60]
    return ""


def component_error_text(comp, missing):
    """رسالة خطأ: معرّف المكوّن/اسمه + الأعمدة المفقودة فقط.
    لا استعلامات ولا قيم صفوف ولا أي تفاصيل داخلية."""
    ident = str(comp.get("id") or "")[:40]
    name = component_name(comp)
    t = str(comp.get("type") or "")
    who = "العنصر «%s»" % (name or t)
    if ident:
        who += " [%s]" % ident
    cols = "، ".join(str(m)[:60] for m in missing[:10])
    return "%s: العمود غير موجود في بيانات المصدر: %s" % (who, cols)


def component_error_html(comp, missing):
    """كتلة خطأ واضحة — لا تُظهر قيمة أو «نجاحًا» وهميًا."""
    return ('<div class="comp-error"><b>تعذّر حساب هذا العنصر</b><br>'
            + esc(component_error_text(comp, missing)) + '</div>')


def validate_report(report, columns=None):
    if not isinstance(report, dict):
        return "report must be an object"
    comps = report.get("components")
    if not isinstance(comps, list):
        return "components must be a list"
    if len(comps) > MAX_COMPONENTS:
        return f"too many components (max {MAX_COMPONENTS})"
    for c in comps:
        if not isinstance(c, dict):
            return "component must be object"
        t = c.get("type")
        if t not in ALLOWED_COMPONENTS:
            return f"unknown component type: {t}"
        if t == "kpi":
            if "column" not in c or "agg" not in c:
                return "kpi requires column and agg"
            if c.get("agg") not in ALLOWED_AGGS:
                return f"unknown agg: {c.get('agg')}"
        elif t in ("bar", "line", "pie"):
            if "category" not in c or "value" not in c:
                return t + " requires category and value"
            if c.get("agg", "sum") not in ALLOWED_AGGS:
                return f"unknown agg: {c.get('agg')}"
        elif t == "table":
            cols = c.get("columns")
            if not isinstance(cols, list) or not cols:
                return "table requires non-empty columns list"
        elif t == "divider":
            pass
        rules = c.get("rules")
        if rules is not None:
            if not isinstance(rules, list) or len(rules) > MAX_RULES:
                return t + " rules must be a list (max %d)" % MAX_RULES
            for r in rules:
                if not isinstance(r, dict) or not r.get("column"):
                    return t + " rule requires column"
                if str(r.get("op", ">")) not in ALLOWED_RULE_OPS:
                    return t + " unknown rule op: " + str(r.get("op"))
    # فحص الأعمدة مقابل البيانات المتاحة (حين تُمرَّر) — يمنع عرض نتيجة مضلِّلة
    if columns is not None:
        for c in comps:
            if not isinstance(c, dict):
                continue
            missing = component_missing_columns(c, columns)
            if missing:
                return component_error_text(c, missing)
    return None

def render_kpi(comp, rows, columns):
    col = comp.get("column")
    if col not in columns:
        # عمود مفقود ⇒ خطأ صريح (لا بطاقة seemingly صالحة ولا قيمة صفرية)
        return component_error_html(comp, [str(col)])
    vals = [r.get(col) for r in rows]
    v = agg_values(vals, comp.get("agg", "sum"))
    dec = comp.get("decimals", None)
    # التنسيق الشرطي: يُطبَّق على القيمة المحسوبة (لا يغيّر الرقم)
    hit = ""
    for rule in normalize_rules(comp):
        if rule_matches(rule, v):
            hit = rule_style(rule)
            break
    value_html = fmt(v, dec)
    if hit:
        value_html = f'<span class="kpi-hit" style="{hit}">{value_html}</span>'
    return (f'<div class="kpi"><div class="kpi-label">{esc(comp.get("label",""))}</div>'
            f'<div class="kpi-value">{value_html}</div>'
            f'<div class="kpi-note">{esc(comp.get("agg",""))} · {len(rows)} سجل</div></div>')

def render_table(comp, rows, columns):
    # لا استبدال صامت: العمود المفقود يُوقف الجدول برسالة صريحة
    missing = component_missing_columns(comp, columns)
    if missing:
        return component_error_html(comp, missing)
    cols = [str(c) for c in (comp.get("columns") or [])]
    # sort
    sort_col = comp.get("sort")
    desc = bool(comp.get("desc", False))
    data = list(rows)
    if sort_col and sort_col in columns:
        def key(r):
            v = r.get(sort_col)
            n = to_num(v)
            return (0, n) if n is not None else (1, str(v) if v is not None else "")
        data.sort(key=lambda r: key(r), reverse=desc)
    limit = comp.get("limit")
    try:
        limit = int(limit) if limit is not None else None
    except (ValueError, TypeError):
        limit = None
    if limit is not None:
        limit = max(1, min(limit, 500))
        data = data[:limit]
    html = ['<div class="tblwrap"><div class="tblmeta">إجمالي السجلات: %d · معروض: %d</div>' % (len(rows), len(data))]
    html.append('<table><thead><tr>')
    for c in cols:
        html.append(f'<th>{esc(c)}</th>')
    html.append('</tr></thead><tbody>')
    rules = normalize_rules(comp)
    for r in data:
        # التنسيق الشرطي على مستوى الصف: أول شرط مطابق يُطبَّق (لا يغيّر الأرقام)
        rstyle = ""
        for rule in rules:
            if rule_matches(rule, r.get(rule.get("column"))):
                rstyle = rule_style(rule)
                break
        tr_open = '<tr style="%s">' % rstyle if rstyle else '<tr>'
        html.append(tr_open)
        for c in cols:
            v = r.get(c)
            html.append(f'<td>{esc(fmt(v, comp.get("decimals"))) if v is not None else "—"}</td>')
        html.append('</tr>')
    html.append('</tbody></table></div>')
    return ''.join(html)

def svg_bar(data, title, width=520, height=260, show_title=True, x_label="", y_label=""):
    if not data:
        return '<div class="chart-empty">لا بيانات</div>'
    # filter null values
    items = [(d["label"], d["value"]) for d in data if d["value"] is not None]
    if not items:
        return '<div class="chart-empty">لا قيم رقمية</div>'
    n = len(items)
    pad = 40
    chart_w = width - 2 * pad
    chart_h = height - 2 * pad - 20
    maxv = max(abs(v) for _, v in items) or 1
    bar_w = chart_w / n * 0.7
    gap = chart_w / n * 0.3
    parts = [f'<svg viewBox="0 0 {width} {height}" class="chart" role="img" aria-label="{esc(title) if show_title else 'مخطط'}">']
    # baseline
    base_y = pad + chart_h
    parts.append(f'<line x1="{pad}" y1="{base_y}" x2="{width-pad}" y2="{base_y}" stroke="currentColor" stroke-opacity="0.3"/>')
    if x_label:
        parts.append(f'<text x="{width/2}" y="{height-3}" text-anchor="middle" font-size="10">{esc(x_label)}</text>')
    if y_label:
        parts.append(f'<text x="14" y="{pad + chart_h/2}" text-anchor="middle" font-size="10" transform="rotate(-90,14,{pad + chart_h/2})">{esc(y_label)}</text>')
    # title
    if title and show_title:
        parts.append(f'<text x="{width/2}" y="20" text-anchor="middle" font-size="13" font-weight="700">{esc(title)}</text>')
    for i, (label, v) in enumerate(items):
        x = pad + i * (bar_w + gap) + gap / 2
        bh = abs(v) / maxv * chart_h
        y = base_y - bh if v >= 0 else base_y
        color = "#5b8cff"
        parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w:.1f}" height="{bh:.1f}" fill="{color}" rx="3"/>')
        # value label
        parts.append(f'<text x="{x + bar_w/2:.1f}" y="{y - 4:.1f}" text-anchor="middle" font-size="10">{fmt(v)}</text>')
        # category label (truncate)
        lbl = label if len(label) <= 10 else label[:9] + "…"
        parts.append(f'<text x="{x + bar_w/2:.1f}" y="{base_y + 14:.1f}" text-anchor="middle" font-size="9">{esc(lbl)}</text>')
    parts.append('</svg>')
    return ''.join(parts)

def svg_line(data, title, width=520, height=260, show_title=True, x_label="", y_label=""):
    items = [(d["label"], d["value"]) for d in data if d["value"] is not None]
    if len(items) < 2:
        return '<div class="chart-empty">لا بيانات كافية لخط</div>'
    pad = 40
    chart_w = width - 2 * pad
    chart_h = height - 2 * pad - 20
    maxv = max(v for _, v in items)
    minv = min(v for _, v in items)
    rng = (maxv - minv) or 1
    n = len(items)
    pts = []
    for i, (label, v) in enumerate(items):
        x = pad + (i / (n - 1)) * chart_w
        y = pad + chart_h - ((v - minv) / rng) * chart_h
        pts.append((x, y))
    path = "M " + " L ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
    parts = [f'<svg viewBox="0 0 {width} {height}" class="chart" role="img" aria-label="{esc(title)}">']
    if title and show_title:
        parts.append(f'<text x="{width/2}" y="20" text-anchor="middle" font-size="13" font-weight="700">{esc(title)}</text>')
    base_y = pad + chart_h
    parts.append(f'<line x1="{pad}" y1="{base_y}" x2="{width-pad}" y2="{base_y}" stroke="currentColor" stroke-opacity="0.3"/>')
    if x_label:
        parts.append(f'<text x="{width/2}" y="{height-3}" text-anchor="middle" font-size="10">{esc(x_label)}</text>')
    if y_label:
        parts.append(f'<text x="14" y="{pad + chart_h/2}" text-anchor="middle" font-size="10" transform="rotate(-90,14,{pad + chart_h/2})">{esc(y_label)}</text>')
    parts.append(f'<path d="{path}" fill="none" stroke="#22d3ee" stroke-width="2"/>')
    for x, y in pts:
        parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3" fill="#22d3ee"/>')
    parts.append('</svg>')
    return ''.join(parts)

def svg_pie(data, title, width=320, height=260, show_title=True, x_label="", y_label=""):
    items = [(d["label"], d["value"]) for d in data if d["value"] is not None and d["value"] > 0]
    if not items:
        return '<div class="chart-empty">لا بيانات</div>'
    total = sum(v for _, v in items)
    if total == 0:
        return '<div class="chart-empty">لا بيانات</div>'
    cx, cy, r = width / 2, height / 2 - 10, min(width, height) / 2 - 30
    parts = [f'<svg viewBox="0 0 {width} {height}" class="chart" role="img" aria-label="{esc(title)}">']
    if title and show_title:
        parts.append(f'<text x="{width/2}" y="16" text-anchor="middle" font-size="13" font-weight="700">{esc(title)}</text>')
    start_angle = -90
    colors = ["#5b8cff", "#22d3ee", "#a78bfa", "#34d399", "#fbbf24", "#fb7185", "#38bdf8"]
    for i, (label, v) in enumerate(items):
        angle = (v / total) * 360
        end_angle = start_angle + angle
        # convert to radians
        import math
        sa = math.radians(start_angle)
        ea = math.radians(end_angle)
        x1 = cx + r * math.cos(sa)
        y1 = cy + r * math.sin(sa)
        x2 = cx + r * math.cos(ea)
        y2 = cy + r * math.sin(ea)
        large = 1 if angle > 180 else 0
        path = f"M {cx} {cy} L {x1:.2f} {y1:.2f} A {r} {r} 0 {large} 1 {x2:.2f} {y2:.2f} Z"
        color = colors[i % len(colors)]
        parts.append(f'<path d="{path}" fill="{color}" stroke="var(--bg,#070b14)" stroke-width="1"/>')
        start_angle = end_angle
    # legend
    ly = height - 10
    parts.append('</svg>')
    # legend below
    legend = '<div class="chart-legend">'
    for i, (label, v) in enumerate(items):
        color = colors[i % len(colors)]
        legend += f'<span><i style="background:{color}"></i>{esc(label)} ({fmt(v)})</span>'
    legend += '</div>'
    return ''.join(parts) + legend

import math

def render_component(comp, rows, columns, layout_columns=GRID_COLUMNS):
    t = comp.get("type")
    # فحص الأعمدة المطلوبة بعد تحديد مصدر البيانات وقبل التنفيذ
    missing = component_missing_columns(comp, columns)
    if missing:
        # يبقى العنصر داخل خانته في الشبكة (لا ينهار إلى عمود واحد)
        css = grid_css(comp, layout_columns)
        return f'<div class="rep-item rep-{esc(t)} rep-error-item" style="{css}">{component_error_html(comp, missing)}</div>'
    if t == "heading":
        inner = f'<h3 class="rep-heading">{esc(comp.get("text",""))}</h3>'
    elif t == "text":
        inner = f'<p class="rep-text">{esc(comp.get("text",""))}</p>'
    elif t == "divider":
        inner = '<hr class="rep-divider" />'
    elif t == "shape":
        # عنصر زخرفي: شريط/صندوق ملوّن بنص اختياري (لا يعتمد على بيانات)
        label = str(comp.get("text", ""))[:200]
        inner = '<div class="rep-shape">%s</div>' % esc(label) if label else '<div class="rep-shape"></div>'
    elif t == "kpi":
        inner = render_kpi(comp, rows, columns)
    elif t == "table":
        inner = render_table(comp, rows, columns)
    elif t == "bar":
        agg = comp.get("agg", "sum")
        data = aggregate(rows, comp.get("category"), comp.get("value"), agg)
        inner = svg_bar(data, comp.get("title", ""), 520, 260, bool(comp.get("showTitle", True)), comp.get("xLabel", ""), comp.get("yLabel", ""))
    elif t == "line":
        agg = comp.get("agg", "sum")
        data = aggregate(rows, comp.get("category"), comp.get("value"), agg)
        inner = svg_line(data, comp.get("title", ""), 520, 260, bool(comp.get("showTitle", True)), comp.get("xLabel", ""), comp.get("yLabel", ""))
    elif t == "pie":
        agg = comp.get("agg", "sum")
        data = aggregate(rows, comp.get("category"), comp.get("value"), agg)
        inner = svg_pie(data, comp.get("title", ""), 320, 260, bool(comp.get("showTitle", True)), comp.get("xLabel", ""), comp.get("yLabel", ""))
    else:
        inner = f'<div class="comp-unknown">Unknown component: {esc(t)}</div>'
    # التخطيط + النمط على مستوى العنصر (سلسلة CSS مُنقّاة — لا مدخلات حرة)
    css = grid_css(comp, layout_columns)
    scss = style_css(comp)
    if scss:
        css = css + ";" + scss
    return f'<div class="rep-item rep-{esc(t)}" style="{css}">{inner}</div>'

CSS = r'''
.rep { font-family: "Tajawal", "Segoe UI", Tahoma, Arial, sans-serif; direction: rtl; color: #e9eefb; }
.rep .kpi { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.1); border-radius: 12px; padding: 12px 14px; }
.rep .kpi-label { font-size: 12px; color: #a7b4cc; }
.rep .kpi-value { font-size: 24px; font-weight: 800; margin-top: 4px; background: linear-gradient(135deg,#5b8cff,#22d3ee); -webkit-background-clip: text; background-clip: text; color: transparent; }
.rep .kpi-note { font-size: 11px; color: #7b89a3; margin-top: 4px; }
.rep .tblwrap { overflow: auto; max-height: 400px; border: 1px solid rgba(255,255,255,.1); border-radius: 10px; }
.rep .tblmeta { font-size: 11px; color: #7b89a3; padding: 6px 10px; }
.rep table { width: 100%; border-collapse: collapse; font-size: 12px; }
.rep th, .rep td { border: 1px solid rgba(255,255,255,.08); padding: 4px 6px; }
.rep th { background: rgba(255,255,255,.06); font-weight: 700; }
.rep .chart { max-width: 100%; height: auto; color: #e9eefb; }
.rep .chart-empty { color: #7b89a3; font-size: 12px; padding: 12px; }
.rep .chart-legend { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; margin-top: 6px; }
.rep .chart-legend span { display: inline-flex; align-items: center; gap: 4px; }
.rep .chart-legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.rep .rep-heading { margin: 12px 0 6px; font-size: 16px; font-weight: 700; }
.rep .rep-text { margin: 6px 0; font-size: 13px; color: #a7b4cc; }
.rep .comp-unknown { color: #fb7185; font-size: 12px; }
.rep .grid { display: grid; gap: 12px; }
.rep .rep-grid { display: grid; align-items: start; }
.rep .rep-item { min-width: 0; }
.rep .rep-divider { border: 0; border-top: 1px solid rgba(255,255,255,.16); margin: 10px 0; }
.rep .rep-shape { min-height: 36px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
  background: rgba(91,140,255,.16); border: 1px solid rgba(91,140,255,.32); color: #c7d2fe; font-size: 13px; padding: 6px 10px; }
.rep .rep-desc { color: #a7b4cc; font-size: 13px; margin: 0 0 14px; }
.rep .kpi-hit { display: inline-block; padding: 0 6px; border-radius: 6px; }
.rep .comp-error { border: 1px solid rgba(251,113,133,.5); background: rgba(251,113,133,.10); color: #ffd9df;
  border-radius: 10px; padding: 10px 12px; font-size: 12px; line-height: 1.7; }
.rep .comp-error b { color: #ff9fb0; }
.rep .rep-errors { border: 1px solid rgba(251,191,36,.45); background: rgba(251,191,36,.10); color: #ffe9b8;
  border-radius: 10px; padding: 10px 12px; font-size: 12px; line-height: 1.7; margin-bottom: 12px; }
.rep .rep-errors ul { margin: 6px 0 0; padding-inline-start: 18px; }
.rep table td, .rep table th { transition: background .12s ease; }
'''

def render(report, rows, columns, standalone=False):
    err = validate_report(report)
    if err:
        return {"ok": False, "error": err}
    if len(rows) > MAX_ROWS:
        rows = rows[:MAX_ROWS]
    layout = report.get("layout") if isinstance(report.get("layout"), dict) else {}
    layout_columns = clamp_int(layout.get("columns"), 2, 24, GRID_COLUMNS)
    gap = clamp_int(layout.get("gap"), 0, 32, 12)
    comps = report.get("components", [])
    body = []
    errors = []
    rows, filtered_out = apply_filters(rows, report.get("filters"))
    for c in comps:
        miss = component_missing_columns(c, columns) if isinstance(c, dict) else []
        if miss:
            errors.append({
                "componentId": str(c.get("id") or ""),
                "type": str(c.get("type") or ""),
                "name": component_name(c),
                "missing": miss,
                "message": component_error_text(c, miss),
            })
        body.append(render_component(c, rows, columns, layout_columns))
    inner = "\n".join(body)
    banner = ""
    if errors:
        items = "".join("<li>%s</li>" % esc(e["message"]) for e in errors)
        banner = ('<div class="rep-errors"><b>تعذّر حساب %d عنصر:</b><ul>%s</ul></div>'
                  % (len(errors), items))
    grid = ('<div class="rep-grid" style="display:grid;grid-template-columns:repeat(%d,minmax(0,1fr));gap:%dpx;align-items:start">%s</div>'
            % (layout_columns, gap, inner))
    if standalone:
        # العنوان: أولًا تعريف التقرير، ثم اسمه، ثم الافتراضي (الملف المُصدَّر فقط —
        # المقطع المضمَّن (fragment) يبقى بلا عنوان كما كان ⇒ توافق مع التقارير القديمة)
        title = str(report.get("title") or report.get("name") or "تقرير")[:120]
        desc = str(report.get("description") or "")[:400]
        desc_html = ("<p class='rep-desc'>" + esc(desc) + "</p>") if desc else ""
        doc = ("<!DOCTYPE html><html lang='ar' dir='rtl'><head><meta charset='utf-8'>"
               "<title>" + esc(title) + "</title>"
               "<style>" + CSS + "</style></head><body><div class='rep'>"
               "<h1>" + esc(title) + "</h1>" + desc_html + banner + grid + "</div></body></html>")
        return {"ok": True, "html": doc, "count": len(comps), "rows": len(rows),
                "filtered": filtered_out, "errors": errors}
    fragment = "<div class='rep'>" + banner + grid + "</div>"
    return {"ok": True, "html": fragment, "count": len(comps), "rows": len(rows),
            "filtered": filtered_out, "errors": errors}


def capabilities():
    pdf_ok = False
    pdf_reason = ''
    try:
        import arabic_reshaper
        from bidi.algorithm import get_display
        pdf_ok = True
    except Exception as e:
        pdf_reason = 'arabic_reshaper/python-bidi unavailable: ' + str(e)
    xl_ok = False
    try:
        import openpyxl
        xl_ok = True
    except Exception as e:
        xl_ok = False
    return {'excel': xl_ok, 'pdf': pdf_ok, 'pdf_reason': pdf_reason, 'python': sys.version.split()[0]}


def export_xlsx(report, rows, columns, output_path):
    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill, Alignment
        from openpyxl.utils import get_column_letter
    except Exception as e:
        return {'ok': False, 'error': 'openpyxl unavailable: ' + str(e)}
    if len(rows) > MAX_ROWS:
        rows = rows[:MAX_ROWS]
    try:
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = 'Results'
        for j, c in enumerate(columns, 1):
            cell = ws.cell(row=1, column=j, value=str(c))
            cell.font = Font(bold=True, color='FFFFFF')
            cell.fill = PatternFill('solid', fgColor='5B8CFF')
            cell.alignment = Alignment(horizontal='center')
        for i, r in enumerate(rows, 2):
            for j, c in enumerate(columns, 1):
                v = r.get(c) if isinstance(r, dict) else None
                if isinstance(v, str) and v and v[0] in ('=', '+', '-', '@', chr(9), chr(13)):
                    v = chr(9) + v
                ws.cell(row=i, column=j, value=v)
        for j, c in enumerate(columns, 1):
            ws.column_dimensions[get_column_letter(j)].width = max(12, min(40, len(str(c)) + 6))
        ws.freeze_panes = 'A2'
        wb.save(output_path)
        return {'ok': True, 'path': output_path, 'rows': len(rows)}
    except Exception as e:
        return {'ok': False, 'error': 'XLSX creation failed: ' + str(e)}


def export_pdf(report, rows, columns, output_path):
    pdf_ok = False
    pdf_reason = ''
    try:
        import arabic_reshaper
        from bidi.algorithm import get_display
        pdf_ok = True
    except Exception as e:
        pdf_reason = 'arabic_reshaper/python-bidi unavailable: ' + str(e)
    if not pdf_ok:
        return {'ok': False, 'error': 'PDF unavailable: ' + pdf_reason}
    try:
        from reportlab.pdfgen import canvas
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        import arabic_reshaper
        from bidi.algorithm import get_display
        import datetime
    except Exception as e:
        return {'ok': False, 'error': 'reportlab unavailable: ' + str(e)}
    try:
        font_path = 'C:/Windows/Fonts/tahoma.ttf'
        pdfmetrics.registerFont(TTFont('Arabic', font_path))
        width, height = A4
        c = canvas.Canvas(output_path, pagesize=A4)
        def sh(t):
            return get_display(arabic_reshaper.reshape(str(t)))
        title = sh(report.get('title', 'Report'))
        c.setFont('Arabic', 16)
        c.drawRightString(width - 40, height - 40, title)
        y = height - 70
        for comp in report.get('components', []):
            if comp.get('type') == 'kpi':
                col = comp.get('column')
                if col in columns:
                    vals = [r.get(col) for r in rows if isinstance(r, dict)]
                    v = agg_values(vals, comp.get('agg', 'sum'))
                    label = sh(comp.get('label', ''))
                    c.setFont('Arabic', 11)
                    c.drawRightString(width - 40, y, label + ': ' + fmt(v))
                    y -= 16
        for comp in report.get('components', []):
            if comp.get('type') == 'table':
                cols = [cc for cc in comp.get('columns', []) if cc in columns]
                if not cols:
                    cols = columns[:6]
                y -= 10
                c.setFont('Arabic', 10)
                x = width - 40
                for cc in cols:
                    c.drawRightString(x, y, str(cc))
                    x -= 90
                y -= 14
                limit = comp.get('limit', 20)
                try:
                    limit = max(1, min(int(limit), 200))
                except (ValueError, TypeError):
                    limit = 20
                for r in rows[:limit]:
                    x = width - 40
                    for cc in cols:
                        val = r.get(cc) if isinstance(r, dict) else ''
                        c.drawRightString(x, y, str(val) if val is not None else '')
                        x -= 90
                    y -= 12
                    if y < 60:
                        c.showPage()
                        y = height - 40
                break
        c.setFont('Arabic', 8)
        c.drawRightString(width - 40, 30, 'Created: ' + str(__import__('datetime').datetime.now()))
        c.save()
        return {'ok': True, 'path': output_path}
    except Exception as e:
        return {'ok': False, 'error': 'PDF creation failed: ' + str(e)}


def main():
    try:
        raw = sys.stdin.read()
        req = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        print(json.dumps({"ok": False, "error": "invalid json input: " + str(e)}))
        return
    action = req.get("action", "render")
    report = req.get("report", {})
    data = req.get("data", {})
    rows = data.get("rows") if isinstance(data, dict) else None
    columns = data.get("columns") if isinstance(data, dict) else None
    has_columns = isinstance(columns, list)
    if not isinstance(rows, list):
        rows = []
    if not isinstance(columns, list):
        columns = list(rows[0].keys()) if rows else []
    if action == "validate":
        # إن مُرِّرت بيانات ⇒ نتحقق من الأعمدة المطلوبة مقابلها (فحص مبكّر قبل الحفظ)
        err = validate_report(report, columns if has_columns else None)
        print(json.dumps({"ok": err is None, "error": err}, ensure_ascii=False))
        return
    if action == "capabilities":
        print(json.dumps({"ok": True, "capabilities": capabilities()}, ensure_ascii=False))
        return
    output_path = req.get("output_path")
    if action == "export_xlsx":
        res = export_xlsx(report, rows, columns, output_path)
        print(json.dumps(res, ensure_ascii=False))
        return
    if action == "export_pdf":
        res = export_pdf(report, rows, columns, output_path)
        print(json.dumps(res, ensure_ascii=False))
        return
    standalone = bool(req.get("standalone", False)) or (action == "export")
    res = render(report, rows, columns, standalone)
    print(json.dumps(res, ensure_ascii=False))

if __name__ == "__main__":
    main()
