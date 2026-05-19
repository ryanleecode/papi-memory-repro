import { paseo_people } from '@polkadot-api/descriptors'
import { createClient } from 'polkadot-api'
import { getWsProvider } from 'polkadot-api/ws'

declare function gc(): void

function forceGC() {
  if (typeof gc === 'function') {
    gc()
    gc()
  }
}

function getRssMB(): number {
  return process.memoryUsage().rss / 1024 / 1024
}

let baselineRss = 0

function logRss(phase: string, details?: string) {
  const current = getRssMB()
  const delta = current - baselineRss
  const deltaStr = delta >= 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1)
  const msg = `[${phase.padEnd(28)}] RSS: ${current.toFixed(1).padStart(7)} MB (${deltaStr} MB)`
  console.log(details ? `${msg}  ${details}` : msg)
}

async function profile() {
  baselineRss = getRssMB()
  logRss('baseline')

  const provider = getWsProvider(['wss://paseo-people-next-rpc.polkadot.io'])
  const client = createClient(provider)
  const typedApi = client.getTypedApi(paseo_people)
  logRss('typed api created')

  console.log('\nCalling typedApi.query.Resources.Consumers.getEntries()...\n')

  forceGC()
  const preGetEntries = getRssMB()
  logRss('before getEntries()')

  const entries = await typedApi.query.Resources.Consumers.getEntries()

  const postGetEntries = getRssMB()
  logRss('after getEntries()', `returned ${entries.length} entries`)

  forceGC()
  logRss('after gc()')

  const delta = postGetEntries - preGetEntries
  const serializedSize = (await import('node:v8')).serialize(entries).byteLength

  console.log('\n' + '='.repeat(60))
  console.log('  SUMMARY')
  console.log('='.repeat(60))
  console.log(`  Chain:                   Paseo People`)
  console.log(`  Storage:                 Resources.Consumers`)
  console.log(`  Total entries:           ${entries.length}`)
  console.log(`  getEntries() RSS delta:  ${delta.toFixed(1)} MB`)
  console.log(`  Per-entry overhead:      ~${((delta * 1024) / entries.length).toFixed(1)} KB`)
  console.log(`  Serialized result size:  ${(serializedSize / 1024 / 1024).toFixed(1)} MB`)
  console.log('='.repeat(60))

  client.destroy()
  process.exit(0)
}

void profile()
