# Contributing

## Run it

Node 22 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:5173/hexhaust/ (the `/hexhaust/` path matters: the app is built for GitHub Pages).

## Before a pull request

```bash
npm run lint
npm run format:check
npm test
npm run build
```

`npm run format` fixes formatting. CI runs the same checks.

## Where code goes

`src/core/` knows nothing about the DOM. New logic goes there and gets a test in `tests/`. Time comes only from a `Clock`, never from `setTimeout` or `performance.now()` directly, so tests can use a fake clock.

## The most useful contribution right now

Hexhaust has not been tried on a real car yet. If you have a CANable adapter, open a [Real car report](https://github.com/lev-oxr/hexhaust/issues/new?template=real_car_report.yml), even if nothing worked. Mask your VIN in any log you attach.
