# Mood Board

A hand-drawn, "crayon"-style infinite-canvas mood board — pan, zoom, drag in images, add sticky notes, and connect them with sketchy lines.

## Files

- `index.html` — page markup
- `style.css` — all styling (hand-drawn crayon look, layout, themes)
- `script.js` — all app behavior (canvas, notes, images, connectors, boards, local save/load)

## Running locally

Just open `index.html` in a browser, or serve the folder with any static file server:

```
npx serve .
```

## Deploying

This folder is a plain static site — deploy it as-is to Vercel, Netlify, GitHub Pages, or any static host. No build step required.

## Notes

- Everything is saved to the browser's local storage automatically — no backend.
- The default color palette is always the light palette, regardless of the visitor's OS light/dark setting.
