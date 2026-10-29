# Everything App

A small, installable to-do and notes app that syncs across devices — the **Home**, **Tasks**, **Links** and **Notebook** pages from my Apps Script "Everything App", rebuilt as a plain static Progressive Web App.

- **Tasks** — add a task (with optional Markdown notes), set a status (To Do / In Progress / Blocked / Done), and tap ☆ to move it into **Today**; everything else waits in **Later**. Archive finished work (⇩), restore it (⇧), edit (✎), delete (✕) and drag the ⠿ handle to reorder.
- **Links** — bookmarks grouped by category (type a new category or pick an existing one). Edit, delete and drag to reorder within a category.
- **Notebook** — sticky-note cards in six colours. Autosave, Markdown preview, drag to reorder.
- **Home** — the overview: counts, a daily checklist that resets every morning, Today / Later / Archived at a glance (you can star/unstar right there), and your latest notes, plus link and note counts.
- **Offline + installable** — a service worker caches the app; add it to your home screen or install it from Chrome/Edge.

No build step, no framework, no server. It's just HTML, CSS and JavaScript.

## Where is my data?

In **Cloud Firestore** (Firebase), under your own account. Sign in with Google or with an email and password, and everything syncs between your devices within a second or so. Each person who signs in gets their own separate, private space — nobody can see anyone else's tasks, links or notes (that's enforced by `firestore.rules`).

It still works **offline**: changes are kept on the device and sent up when you're back online. **Account menu → Export backup** downloads everything as a `.json` file if you want your own copy.

## One-time Firebase setup (about 20 minutes)

Firebase's free "Spark" plan is plenty for this — no credit card needed.

1. **Create the project.** Go to <https://console.firebase.google.com>, click **Create a project**, name it (e.g. `everything-app`), turn Google Analytics **off** (not needed), and create it.
2. **Register the web app.** On the project's home page click the **Web** icon (`</>`). Nickname: `Everything App`. Leave "Firebase Hosting" unchecked. Click **Register app**. You'll see a `firebaseConfig = { … }` block — keep that page open.
3. **Paste the config.** Open `js/firebase-config.js` and replace the placeholder values with the ones from that block (`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`). These aren't secrets; it's fine for them to be in a public repo.
4. **Turn on sign-in.** In the left menu: **Build → Authentication → Get started → Sign-in method**.
   - Enable **Google** (pick your email as the support email) → **Save**.
   - Enable **Email/Password** (just the first toggle) → **Save**.
5. **Allow your website.** Still in Authentication: **Settings → Authorized domains → Add domain** → `<your-username>.github.io`. (`localhost` is already there for testing.)
6. **Create the database.** **Build → Firestore Database → Create database**. Pick a location near you (e.g. `us-east1` or `nam5`) — this can't be changed later. Choose **Start in production mode** → **Create**.
7. **Lock it down.** Open the **Rules** tab, replace everything with the contents of `firestore.rules`, and click **Publish**. This is the bit that keeps each person's data private — don't skip it.
8. **Commit and push** your updated `js/firebase-config.js`. Open the site, sign in, done.

### Notes

- **iPhone home-screen app:** Google sign-in opens a pop-up, which iOS sometimes blocks inside home-screen apps. If it doesn't work there, use **Create an account** with an email and password instead (that works everywhere). The home-screen app on iPhone has its own storage separate from Safari, so you sign in once inside it.
- **Adding someone else (e.g. family):** they just open the link and sign in or create an account. They get their own empty app.
- **Data from before sync:** the first time you sign in on a device that already had tasks/links/notes from the earlier version, the app offers to copy them into your account.

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
| Upgrade the Firebase SDK | `SDK_VERSION` in `js/cloud.js` **and** `SDK` in `sw.js` |
| Change the default daily checklist | `DEFAULT_DAILY` in `js/app.js` (or just tap **Edit** on Home) |
| Colours / layout | `css/styles.css` |

**After changing any file, bump `VERSION` in `sw.js`** (e.g. `v3` → `v4`) so installed copies pick up the update.

## Files

```
index.html             page shell, sign-in screen and the four views
css/styles.css         styles (light + dark mode, phone layout)
js/firebase-config.js  your Firebase project's config (edit this)
js/cloud.js            loads and starts Firebase
js/store.js            Firestore data store, live sync, backups
js/markdown.js         tiny, safe Markdown renderer
js/app.js              UI: sign-in, Home, Tasks, Links, Notebook
firestore.rules        security rules — paste into Firebase console
manifest.webmanifest   PWA manifest
sw.js                  service worker (offline cache)
icons/                 app icons
```
