# Skys

Skys is a personal, always-on autonomous agent. Hand it something once and it
keeps working in the background, checks with you before anything risky, and
learns how you like things done.

- [`web/`](web) is the web app (React, TypeScript, Vite).
- [`docs/DESIGN.md`](docs/DESIGN.md) covers the look, the screens and the principles.
- [`docs/API.md`](docs/API.md) is the contract the back end implements.

```
cd web
npm install
npm run dev
```

The app runs on built-in sample data until `VITE_SKYS_API_URL` points it at a back end.
