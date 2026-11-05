"""email_kit: inlined styles, plain-text part, client-safe wrapper."""
from unittest.mock import MagicMock, patch

from email_kit import html_to_text, inline_styles, wrap_email


def test_inline_styles_adds_style_to_bare_tags():
    assert '<h2 style="color:#2c3e50' in inline_styles("<h2>x</h2>")


def test_inline_styles_keeps_existing_style():
    src = '<p style="color:red">x</p>'
    assert inline_styles(src) == src


def test_inline_styles_merges_with_other_attributes_without_duplicate_style():
    out = inline_styles('<table class="x"><tr><td colspan="2">a</td></tr></table>')
    assert out.count("style=") == 2
    assert '<table class="x" style=' in out
    assert '<td colspan="2" style=' in out


def test_inline_styles_th_gets_header_styling():
    out = inline_styles("<table><tr><th>a</th></tr></table>")
    assert "background:#f8f9fa;font-weight:600" in out


def test_summary_table_right_aligns_non_first_cells():
    out = inline_styles('<table class="summary"><tr><td>a</td><td>1</td></tr></table>')
    first = out.index("<td")
    second = out.index("<td", first + 1)
    assert "text-align:right" not in out[first:second]
    assert "text-align:right" in out[second:]


def test_summary_alignment_resets_each_row_and_table():
    out = inline_styles(
        '<table class="summary"><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></table>'
        '<table><tr><td>c</td><td>3</td></tr></table>')
    cells = out.split("<td")[1:]
    aligned = ["text-align:right" in c.split(">")[0] for c in cells]
    assert aligned == [False, True, False, True, False, False]


def test_html_to_text_links_and_entities():
    html = '<h2>A &amp; B</h2><p>see <a href="https://x.test/?a=1&amp;b=2">here</a></p>'
    assert html_to_text(html) == "A & B\n\nsee here (https://x.test/?a=1&b=2)"


def test_html_to_text_table_rows():
    assert html_to_text("<table><tr><td>Lights</td><td>3.2 kWh</td></tr></table>") == "Lights | 3.2 kWh"


def test_html_to_text_drops_style_head_and_images():
    html = ("<html><head><style>p{color:red}</style></head><body>"
            '<p>hi</p><img src="data:image/png;base64,AAAA"><p>bye</p></body></html>')
    assert html_to_text(html) == "hi\nbye"


def test_wrap_email_is_complete_and_has_dark_block():
    out = wrap_email("<h2>x</h2>")
    assert out.startswith("<!DOCTYPE html>")
    assert "color-scheme" in out
    assert "prefers-color-scheme: dark" in out
    assert out.count("<style") == 1
    assert "max-width:600px" in out
    assert '<h2 style="color:#2c3e50' in out


def test_send_email_posts_text_part(monkeypatch):
    import daily_report as d
    monkeypatch.delenv("DRY_RUN", raising=False)
    resp = MagicMock()
    resp.json.return_value = {"id": "abc"}
    with patch.object(d.httpx, "post", return_value=resp) as post:
        d.send_email("<h2>Hi</h2><p>there</p>", "subj")
    body = post.call_args.kwargs["json"]
    assert body["subject"] == "subj"
    assert body["html"] == "<h2>Hi</h2><p>there</p>"
    assert body["text"] == "Hi\n\nthere"


def test_send_email_dry_run_posts_nothing(monkeypatch):
    import daily_report as d
    monkeypatch.setenv("DRY_RUN", "1")
    with patch.object(d.httpx, "post") as post:
        d.send_email("<p>x</p>", "subj")
    post.assert_not_called()
