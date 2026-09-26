# storefront-web

A small Next.js 16 app on `eslint-config-next`, kept here because a Next app lists the config in
package.json and none of the plugins it registers. Install it, then scan it:

```
npm install
npx eslint10-matrix scan .
```

All six plugins come through eslint-config-next, and the report says so on each row. Versions are
pinned exactly, so the output in the project README is reproducible from this directory.
