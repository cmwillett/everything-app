# Everything App

A small, installable to-do and notes app — the **Home**, **Tasks**, **Links** and **Notebook** pages from my Apps Script "Everything App", rebuilt as a plain static Progressive Web App.

- **Tasks** — add a task (with optional Markdown notes), set a status (To Do / In Progress / Blocked / Done), and tap ☆ to move it into **Today**; everything else waits in **Later**. Archive finished work (⇩), restore it (⇧), edit (✎), delete (✕) and drag the ⠿ handle to reorder.
- **Links** — bookmarks grouped by category (type a new category or pick an existing one). Edit, delete and drag to reorder within a category.
- **Notebook** — sticky-note cards in six colours. Autosave, Markdown preview, drag to reorder.
- **Home** — the overview: counts, a daily checklist that resets every morning, Today / Later / Archived at a glance (you can star/unstar right there), and your latest notes, plus link and note counts.
- **Offline + installable** — a service worker caches the app; add it to your home screen or install it from Chrome/Edge.

No build step, no framework, no server. It's just HTML, CSS and JavaScript.

## Where is my data?

In your browser's `localStorage`, on the device you're using. That means it's private and works offline, but **it doesn't sync between devices** and clearing site data deletes it. Use **Data → Export backup** regularly, and **Data → Import backup** to restore or move to another device.

> If you ever want sync, `js/store.js` is the only file that talks to storage — swap it for something like Firebase, Supabase or a Google Sheet API and the rest of the app stays the same.

## Run it locally

Service workers need `http://`, not `file://`, so serve the folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(or `npx serve .`)

## Publish on GitHub Pages

1. Create a new repository on GitHub (e.g. `everything-app`) and push these files to the `main` branch:
   ```bash
   git init
   git add .
   git commit -m "Everything App PWA"
   git branch -M main
   git remote add origin https://github.com/<your-username>/everything-app.git
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick `main` and `/ (root)`, then **Save**.
3. After a minute it's live at `https://<your-username>.github.io/everything-app/`.

All paths are relative, so it works from a sub-folder like that without changes.

## Install it

- **Android / Chrome / Edge:** open the site and tap **Install** in the top bar (or the browser's "Install app" menu item).
- **iPhone / iPad:** open the site in Safari → Share → **Add to Home Screen**.

## Making changes

| Want to… | Edit |
|---|---|
| Rename "Today" / "Later" (e.g. to "Current") | `LABEL_NOW` / `LABEL_LATER` at the top of `js/app.js` |
| Change task statuses or note colours | `STATUSES` / `COLORS` in `js/store.js` |
| Change the default daily checklist | `DEFAULT_DAILY` in `js/app.js` (or just tap **Edit** on Home) |
| Colours / layout | `css/styles.css` |

**After changing any file, bump `VERSION` in `sw.js`** (e.g. `v1` → `v2`) so installed copies pick up the update.

## Files

```
index.html             page shell and the three views
css/styles.css         styles (light + dark mode, phone layout)
js/store.js            local data store + backup import/export
js/markdown.js         tiny, safe Markdown renderer
js/app.js              UI: Home, Tasks, Notebook, drag-to-reorder
manifest.webmanifest   PWA manifest
sw.js                  service worker (offline cache)
icons/                 app icons
```
