import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: [
      // maia3-js imports the bare 'onnxruntime-web' entry, which bundles the
      // 28 MB WebGPU (JSEP) wasm. The app only uses the plain CPU wasm
      // provider, so point at the wasm-only entry (~15 MB), which stays under
      // Cloudflare Pages' 25 MiB per-file limit.
      { find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/wasm' },
    ],
  },
});
