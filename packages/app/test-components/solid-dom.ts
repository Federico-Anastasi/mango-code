import { plugin } from "bun"
import { createRequire } from "node:module"

// Component tests need Solid's real compiler (reactive bindings, lazy children); the shared test preload compiles JSX
// against the hyperscript runtime, which evaluates everything once. Babel parses the TypeScript and compiles the JSX;
// Bun then strips the types.
const need = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = need("@babel/core") as typeof import("@babel/core")
const preset = need.resolve("babel-preset-solid")
const stripTypes = new Bun.Transpiler({ loader: "ts", trimUnusedImports: true })

plugin({
  name: "solid-dom",
  setup(build) {
    build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => {
      const out = await babel.transformAsync(await Bun.file(args.path).text(), {
        filename: args.path,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [[preset, { generate: "dom", hydratable: false }]],
      })
      return { contents: stripTypes.transformSync(out?.code ?? ""), loader: "js" }
    })
  },
})
