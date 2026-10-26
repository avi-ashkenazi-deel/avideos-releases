// Raw source of the woff2 Emscripten decoder (single-file build, wasm inlined).
// Loaded lazily and run inside a Worker so its CommonJS/global `Module`
// conventions never meet the bundler's module interop.
import src from 'wawoff2/build/decompress_binding.js?raw';
export default src as string;
