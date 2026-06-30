// lib/ollama.ts
//
// One place for the model-lane config, so the whole app can be pointed at a
// different Ollama by flipping a single env var — the foundation for the GPU
// lane policy (M90t pins services; Framerstation kicks on-demand; zone
// scheduling later).
//
//   ATELIER_OLLAMA_URL        which Ollama to call.
//                             - Framerstation (shared, on-demand): http://192.168.4.176:11434  (default)
//                             - M90t pinned lane (Atelier's own GPU):  http://127.0.0.1:11434
//   ATELIER_OLLAMA_KEEPALIVE  how long Ollama holds the model warm after a call.
//                             On Framerstation keep this modest so the lane stays
//                             on-demand for other work; on M90t's pinned lane it
//                             can be long (e.g. '30m') since M90t is the host that
//                             is allowed to pin services.

export const OLLAMA_URL = process.env.ATELIER_OLLAMA_URL ?? 'http://192.168.4.176:11434';

// Default '5m' = Ollama's own default; respects "Framerstation kicks on-demand".
export const OLLAMA_KEEPALIVE = process.env.ATELIER_OLLAMA_KEEPALIVE ?? '5m';
