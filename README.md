# Chief of Staff Intelligence Dashboard

Static dashboard tracking competitor activity and broader AI/banking news.
Data refreshed daily via GitHub Actions; site served from GitHub Pages.

## Layout

```
docs/              # GitHub Pages root (site + data + notes)
  index.html
  app.js
  styles.css
  data/            # JSON written by fetch.py
  notes/           # one .md per item — your "my take"
scripts/
  fetch.py         # pulls from HN, Reddit, Bluesky, RSS, Google News, Product Hunt
  requirements.txt
.github/workflows/
  fetch.yml        # daily 7am PT cron
```

## Tracked competitors

Eltropy, Kasisto, Posh, Glia, Active.Ai, Omilia, Gridspace, Born Digital.

## Local development

```
python -m venv .venv
.venv\Scripts\activate
pip install -r scripts/requirements.txt
python scripts/fetch.py
```

Then open `docs/index.html` — but because the page fetches JSON, you need a local server:

```
python -m http.server --directory docs 8000
# visit http://localhost:8000
```

## Adding "my take" notes

Each item has a stable `id`. Create `docs/notes/<id>.md` and write whatever you want — it'll render inline next time the page loads.
