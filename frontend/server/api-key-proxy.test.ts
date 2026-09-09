import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import { loadConfigFromFile } from 'vite'

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

test('real Node proxy rejects invalid Tutor key before streaming and forwards authenticated SSE incrementally', async () => {
  const authorization = `Bearer lfak_${'b'.repeat(43)}`
  let finishStream = () => {}
  let sawCredential = false
  const backend = createServer((request, response) => {
    if (request.url === '/api/auth/api-key/verify') {
      response.writeHead(request.headers.authorization === authorization ? 204 : 401).end()
      return
    }
    if (request.url === '/api/test/events') {
      sawCredential = request.headers.authorization === authorization && !request.headers.cookie
      if (!sawCredential) { response.writeHead(401).end(); return }
      response.writeHead(200, {'Content-Type':'text/event-stream'})
      response.write('data: first\n\n')
      finishStream = () => response.end('data: last\n\n')
      return
    }
    response.writeHead(404).end()
  })
  const backendBase = await listen(backend)
  const previous = process.env.LEARNFLOW_BACKEND_URL
  process.env.LEARNFLOW_BACKEND_URL = backendBase
  let proxy: Server | undefined
  try {
    const loaded = await loadConfigFromFile({command:'serve',mode:'test'})
    const middleware: Array<(request:any,response:any,next:()=>void)=>void> = []
    for (const plugin of loaded!.config.plugins!.flat(Infinity) as any[]) {
      if (plugin?.name === 'learnflow-local-tutor-proxy' || plugin?.name === 'learnflow-formal-backend-proxy') {
        plugin.configureServer({middlewares:{use:(handler:any)=>middleware.push(handler)}})
      }
    }
    assert.equal(middleware.length,2)
    proxy = createServer((request,response) => {
      let index = 0
      const next = () => {
        const handler = middleware[index++]
        if (handler) void handler(request,response,next)
        else response.writeHead(404).end()
      }
      next()
    })
    const base = await listen(proxy)
    const invalid = await fetch(`${base}/api/tutor/stream`, {method:'POST',headers:{Authorization:'Bearer invalid',Cookie:'valid-but-unrelated', 'Content-Type':'application/json'},body:'{}'})
    assert.equal(invalid.status,401)
    assert.match(invalid.headers.get('content-type') || '', /application\/json/)
    const stream = await fetch(`${base}/api/test/events`, {headers:{Authorization:authorization,Cookie:'unrelated-cookie'},signal:AbortSignal.timeout(5000)})
    assert.equal(stream.status,200)
    assert.equal(stream.headers.get('x-accel-buffering'),'no')
    const reader = stream.body!.getReader()
    const first = await reader.read()
    assert.equal(new TextDecoder().decode(first.value),'data: first\n\n')
    assert.ok(sawCredential)
    finishStream()
    let tail = ''
    for (;;) { const part = await reader.read(); if (part.done) break; tail += new TextDecoder().decode(part.value) }
    assert.equal(tail,'data: last\n\n')
  } finally {
    finishStream()
    if (previous === undefined) delete process.env.LEARNFLOW_BACKEND_URL
    else process.env.LEARNFLOW_BACKEND_URL = previous
    for (const server of [proxy, backend]) if (server) { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())) }
  }
})
