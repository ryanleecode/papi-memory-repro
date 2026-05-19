import { getDynamicBuilder, getLookupFn } from '@polkadot-api/metadata-builders'
import { decAnyMetadata, Twox128, unifyMetadata } from '@polkadot-api/substrate-bindings'
import { ss58Address } from '@polkadot-labs/hdkd-helpers'
import { createClient } from 'polkadot-api'
import { fromHex, mergeUint8, toHex } from 'polkadot-api/utils'
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
  logRss('client created')

  const rawMeta = await client._request<string>('state_getMetadata', [])
  const metadataBytes = fromHex(rawMeta as `0x${string}`)
  const metadata = unifyMetadata(decAnyMetadata(metadataBytes))
  const lookup = getLookupFn(metadata)
  const { buildStorage, buildDefinition } = getDynamicBuilder(lookup)
  const consumersStorage = buildStorage('Resources', 'Consumers')

  type MetadataPallet = { name: string; constants: Array<{ name: string; type: number; value: Uint8Array }> }
  const pallets = (metadata as unknown as { pallets: MetadataPallet[] }).pallets
  const ss58Const = pallets.find((p) => p.name === 'System')?.constants.find((c) => c.name === 'SS58Prefix')
  const ss58Prefix: number = ss58Const ? (buildDefinition(ss58Const.type).dec(ss58Const.value) as number) : 42

  const storagePrefix = toHex(
    mergeUint8([
      Twox128(new TextEncoder().encode('Resources')),
      Twox128(new TextEncoder().encode('Consumers')),
    ]),
  )
  const accountIdOffset = storagePrefix.length + 32

  logRss('codecs ready')

  const finalizedHead = await client._request<string>('chain_getFinalizedHead', [])

  console.log('\nFetching Resources.Consumers with manual key decode...\n')

  forceGC()
  const preGetEntries = getRssMB()
  logRss('before fetch')

  const decoded: Array<{ key: string; value: unknown }> = []
  let cursor: string | null = null

  do {
    const keys: string[] = await client._request<string[]>('state_getKeysPaged', [
      storagePrefix,
      1000,
      cursor,
      finalizedHead,
    ])
    if (keys.length === 0) break

    const changes = await client._request<
      Array<{ block: string; changes: Array<[string, string | null]> }>
    >('state_queryStorageAt', [keys, finalizedHead])

    for (const { changes: pairs } of changes) {
      for (const [keyHex, valueHex] of pairs) {
        if (!valueHex) continue
        const pubkey = fromHex(`0x${keyHex.slice(accountIdOffset, accountIdOffset + 64)}` as `0x${string}`)
        const accountId = ss58Address(pubkey, ss58Prefix)
        const value = consumersStorage.value.dec(valueHex)
        decoded.push({ key: accountId, value })
      }
    }

    cursor = keys.length < 1000 ? null : keys[keys.length - 1]
  } while (cursor)

  const postGetEntries = getRssMB()
  logRss('after fetch', `returned ${decoded.length} entries`)

  forceGC()
  logRss('after gc()')

  const delta = postGetEntries - preGetEntries
  const serializedSize = (await import('node:v8')).serialize(decoded).byteLength

  console.log('\n' + '='.repeat(60))
  console.log('  SUMMARY')
  console.log('='.repeat(60))
  console.log(`  Chain:                   Paseo People`)
  console.log(`  Storage:                 Resources.Consumers`)
  console.log(`  Total entries:           ${decoded.length}`)
  console.log(`  Manual decode RSS delta: ${delta.toFixed(1)} MB`)
  console.log(`  Per-entry overhead:      ~${((delta * 1024) / decoded.length).toFixed(1)} KB`)
  console.log(`  Serialized result size:  ${(serializedSize / 1024 / 1024).toFixed(1)} MB`)
  console.log('='.repeat(60))

  client.destroy()
  process.exit(0)
}

void profile()
