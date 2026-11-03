# Contributing to PDF Studio

Thanks for helping improve PDF Studio. Bug reports, documentation improvements and focused pull requests are welcome.

## Report a problem

[Open an issue](https://github.com/kingrebelf/PDF-Studio/issues/new) with your operating system, steps to reproduce, what you expected, and what happened. Include a screenshot or a small sample PDF only if you have permission to share it. Remove personal and confidential information first.

## Develop locally

Install Node.js 22.12 or later, then:

```bash
npm ci
npm start
npm run check
npm test
npm audit
```

Try the bundled sample as well as a representative PDF when changing rendering or editing behavior. For a pull request, describe the change and how you tested it. Include screenshots for visible interface changes.

## Project layout

- `main.js` and `preload.js` — Electron window, platform integration and renderer bridge.
- `app/js/` — viewer, editor, document operations and interface modules.
- `app/css/` and `app/index.html` — application styling and shell.
- `app/vendor/` — bundled PDF.js and pdf-lib; retain their license notices when updating.
- `app/assets/` — sample document, font and icon.
- `scripts/` — static checks and sample generator.
- `docs/screenshots/` — screenshots for the repository.
- `.github/workflows/` — checks and platform packaging.

Avoid committing generated builds, dependencies, private PDFs or secrets. Packaging commands and platform notes are in the [README](README.md).
