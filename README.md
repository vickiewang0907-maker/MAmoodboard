# Mood Board

A pan/zoom infinite canvas for dropping images and text notes, connecting
them with hand-drawn "crayon" style lines.

## Files
- `index.html` — page markup
- `style.css` — all styles (including the embedded "I Eat Crayons" handwritten font, so it works for every visitor with no extra setup)
- `script.js` — all behavior

## Run locally
Just open `index.html` in a browser, or serve the folder with any static
server, e.g.:

    npx serve .

## Deploy
This is a static site — any static host works. Two common options:

**Vercel (recommended, free):**
1. Push this folder to a GitHub repo.
2. Go to vercel.com → "Add New Project" → import that repo.
3. Leave all build settings blank (no framework, no build command) — Vercel
   will serve the files as-is. Deploy.

**GitHub Pages:**
1. Push this folder to a GitHub repo.
2. Repo Settings → Pages → Source: deploy from branch → main → `/ (root)`.
