// worker.js (optional future use)
// This is a placeholder web worker file to offload heavy procedural generation if needed.
// Currently unused by Phase 2 but included for Phase 3+.

self.addEventListener('message', (e) => {
  const data = e.data;
  // expected messages: { cmd: 'generateNode', nodeSpec: {...} }
  if(data && data.cmd === 'ping'){
    self.postMessage({ cmd: 'pong', time: Date.now() });
  }
});
