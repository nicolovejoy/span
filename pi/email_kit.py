"""Email HTML helpers: inlined styles, plain-text part, client-safe wrapper.

Pure string functions, stdlib only. Many mail clients drop <style> blocks, so
the base look is inlined onto each tag; the single <style> block left in the
document only carries the dark-mode override for clients that honour it."""
import html as _html
import re

_H = "color:#2c3e50;"
_CELL = "padding:6px 12px;text-align:left;border-bottom:1px solid #eee"
_STYLES = {
    "h2": _H + "border-bottom:2px solid #3498db;padding-bottom:8px",
    "h3": _H + "margin-top:24px",
    "table": "border-collapse:collapse;width:100%;margin:8px 0",
    "th": _CELL + ";background:#f8f9fa;font-weight:600",
    "td": _CELL,
}
_RIGHT_TD = _CELL.replace("text-align:left", "text-align:right")

# Opening tags we style, plus the structural ones tracked for summary tables.
_TAG_RE = re.compile(r"<(/?)(h2|h3|table|th|td|p|tr)\b([^>]*)>", re.IGNORECASE)


def inline_styles(html: str) -> str:
    """Add inline `style` to bare h2/h3/table/th/td/p tags. Tags that already
    carry a style are untouched. In `<table class="summary">` every cell after
    the first in a row is right-aligned."""
    in_summary = False
    cell_idx = 0

    def repl(m: re.Match) -> str:
        nonlocal in_summary, cell_idx
        closing, name, attrs = m.group(1), m.group(2).lower(), m.group(3)
        if closing:
            if name == "table":
                in_summary = False
            return m.group(0)
        if name == "table":
            in_summary = bool(re.search(r'class\s*=\s*["\'][^"\']*\bsummary\b', attrs))
        elif name == "tr":
            cell_idx = 0
        is_cell = name in ("td", "th")
        idx = cell_idx
        if is_cell:
            cell_idx += 1
        if name in ("tr", "p") or re.search(r"\bstyle\s*=", attrs, re.IGNORECASE):
            style = None
        elif name == "td" and in_summary and idx > 0:
            style = _RIGHT_TD
        else:
            style = _STYLES[name]
        if style is None:
            return m.group(0)
        trailing = " /" if attrs.rstrip().endswith("/") else ""
        attrs = attrs.rstrip().removesuffix("/").rstrip()
        return f'<{m.group(2)}{attrs} style="{style}"{trailing}>'

    return _TAG_RE.sub(repl, html)


def html_to_text(html: str) -> str:
    """Plain-text alternative for the HTML body."""
    t = re.sub(r"<(style|head)\b.*?</\1\s*>", "", html, flags=re.S | re.I)
    t = re.sub(r"<img\b[^>]*>", "", t, flags=re.I)
    t = re.sub(r'<a\b[^>]*?href\s*=\s*"([^"]*)"[^>]*>(.*?)</a\s*>', r"\2 (\1)", t, flags=re.S | re.I)
    t = re.sub(r"<h[23]\b[^>]*>(.*?)</h[23]\s*>", r"\1\n\n", t, flags=re.S | re.I)
    t = re.sub(r"</t[hd]\s*>\s*(?=<t[hd]\b)", " | ", t, flags=re.I)
    t = re.sub(r"</(p|tr|table)\s*>|<br\s*/?>", "\n", t, flags=re.I)
    t = re.sub(r"<[^>]+>", "", t)
    t = _html.unescape(t)
    t = "\n".join(line.strip() for line in t.splitlines())
    return re.sub(r"\n{3,}", "\n\n", t).strip()


_DARK = """<style>
@media (prefers-color-scheme: dark) {
  body, h2, h3, p, td { color: #e8e8e8 !important; }
  th { background: #2a2d31 !important; color: #e8e8e8 !important; }
  h2 { border-bottom-color: #3498db !important; }
  td, th { border-bottom-color: #444 !important; }
}
</style>"""

_WRAP_DIV = ('<div style="font-family:-apple-system,sans-serif;max-width:600px;'
             'margin:0 auto;padding:20px;color:#333;">')


def wrap_email(body: str) -> str:
    """Complete HTML document around `body`, styles inlined, with a dark-mode
    override block. No body background is set: clients invert on their own."""
    return (f'<!DOCTYPE html>\n<html><head><meta charset="utf-8">\n'
            f'<meta name="color-scheme" content="light dark">\n'
            f'<meta name="supported-color-schemes" content="light dark">\n{_DARK}\n</head>\n'
            f'<body>\n{_WRAP_DIV}\n{inline_styles(body)}\n</div>\n</body></html>')
