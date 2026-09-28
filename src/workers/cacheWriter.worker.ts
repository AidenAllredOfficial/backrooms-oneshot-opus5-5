// src/workers/cacheWriter.worker.ts — the tool cache's writer (tool runs only; tileCache.ts). Each bake worker starts
// one lazily and transfers every encoded result to it (zero-copy), so compressing and uploading an entry never
// runs on a bake thread (it cost ~25% of cold-shot time there: 70 ms of gzip + the PUT per 4-7 MB entry, and a raw
// upload from the bake thread measured even slower). Messages: { url, bytes, raw }. raw: PUT the bytes as they are
// with X-BR-Raw: 1 (the server gzips them); else gzip here (CompressionStream) and PUT the gzip. Every message is
// acknowledged with { done: 1 } once its PUT has settled (the bake worker bounds what it hands over).

interface WriteJob { url: string; bytes: Uint8Array<ArrayBuffer>; raw: boolean }

async function gzipBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

let chain: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent<WriteJob>): void => {
  const job = e.data;
  // one entry at a time: the queue lives in the bake worker's bound, not in this thread's memory
  chain = chain.then(async () => {
    try {
      if (job.raw) await fetch(job.url, { method: 'PUT', body: job.bytes, headers: { 'X-BR-Raw': '1' } });
      else await fetch(job.url, { method: 'PUT', body: await gzipBytes(job.bytes) });
    } catch { /* the cache is an optimisation: a lost entry is a later miss */ }
    self.postMessage({ done: 1 });
  });
};
