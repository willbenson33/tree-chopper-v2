# tree-chopper-v2 — Claude instructions

## After any code change: build and deploy to GitHub Pages

Run these steps every time source files are modified:

```bash
# 1. Build
npm run build

# 2. Push dist/ to the gh-pages branch
git worktree add /tmp/gh-pages-deploy origin/gh-pages
cp -r dist/. /tmp/gh-pages-deploy/
cd /tmp/gh-pages-deploy
git checkout -b gh-pages 2>/dev/null || git checkout gh-pages
git add -A
git commit -m "Deploy: <short description of change>"
git push origin HEAD:gh-pages
cd -
git worktree remove /tmp/gh-pages-deploy
```

The live site is at: https://willbenson33.github.io/tree-chopper-v2/

## Dev commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Local dev server |
| `npm run build` | TypeScript check + Vite production build → `dist/` |

## Project layout

- `src/components/RavenHop.tsx` — all game logic and canvas rendering (~1750 lines)
- `src/components/RavenHop.css` — UI overlay styles
- `vite.config.ts` — base path set to `/tree-chopper-v2/` for GitHub Pages
