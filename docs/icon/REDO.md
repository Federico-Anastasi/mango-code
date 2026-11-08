# Redoing the icon

The sources are `app/src-tauri/icons/mango.svg` (full) and `mango-small.svg` (5 lines, for 16-32 px). From `app/src-tauri`: `cargo tauri icon icons/mango.svg -o <A>` and `... mango-small.svg -o <B>`; copy the files of `<A>` into `icons/` (not the `android` and `ios` folders) and `<B>/32x32.png`; `mango-1024.png` is `mango.svg` rendered at 1024 px.
`icon.ico` is composed with `node ../../docs/icon/small-ico.mjs <A>/icon.ico <B>/icon.ico icons/icon.ico` (16, 24, 32 px from the small one); the agent's web UI has the same design in `packages/ui/src/assets/favicon` and in `components/logo.tsx`.
