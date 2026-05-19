# `getEntries()` causes 2 GB RSS spike for 37k storage entries (~57 KB per 81-byte key)

## Description

Calling `typedApi.query.Resources.Consumers.getEntries()` on the Paseo People chain (~37k entries) causes a **2 GB RSS spike**. The same data decoded with manual hex-slicing of storage keys uses **120 MB** — a 17x difference.

The root cause is `keys.dec()` in `storage.js` line 159. It's called inside a synchronous `.map()` over all entries with no GC yield points:

```js
const decodedValues = values.map(({ key, value }) => ({
  keyArgs: codecs.keys.dec(key),   // ← ~57 KB of transient allocations per key
  value: codecs.value.dec(value)
}));
```

Each `keys.dec()` call allocates ~57 KB of V8 objects to decode an 81-byte SCALE key (a single `AccountId32`). The allocation chain includes:

1. `fromHex` → `toInternalBytes` creates 2x `InternalUint8Array` + `DataView`
2. `BytesDec` does `buffer.slice` copies
3. `codec.enc(result[i]).length` in `dynamic-builder.js` re-encodes the decoded key just to measure byte length (the hasher/key sizes are compile-time constants)
4. SS58 encoding allocates trie nodes in `withSs58Cache`

## Reproduction

Clone the repo and run:

```bash
pnpm install
node --expose-gc --import tsx profile-typed.ts      # typed API — shows 2 GB spike
node --expose-gc --import tsx profile-optimized.ts   # manual decode — shows 120 MB
```

### Typed API output

```
[baseline                    ] RSS:   108.6 MB (+0.0 MB)
[typed api created           ] RSS:   114.7 MB (+6.1 MB)

Calling typedApi.query.Resources.Consumers.getEntries()...

[before getEntries()         ] RSS:   115.7 MB (+7.1 MB)
[after getEntries()          ] RSS:  2178.5 MB (+2069.9 MB)  returned 37022 entries
[after gc()                  ] RSS:  2181.1 MB (+2072.5 MB)

============================================================
  SUMMARY
============================================================
  Chain:                   Paseo People
  Storage:                 Resources.Consumers
  Total entries:           37022
  getEntries() RSS delta:  2062.8 MB
  Per-entry overhead:      ~57.1 KB
============================================================
```

### Optimized output (manual hex-slice, same data)

```
[baseline                    ] RSS:   113.7 MB (+0.0 MB)
[client created              ] RSS:   119.8 MB (+6.1 MB)
[codecs ready                ] RSS:   136.4 MB (+22.6 MB)

Fetching Resources.Consumers with manual key decode...

[before fetch                ] RSS:   137.0 MB (+23.2 MB)
[after fetch                 ] RSS:   257.5 MB (+143.8 MB)  returned 37022 entries
[after gc()                  ] RSS:   257.8 MB (+144.1 MB)

============================================================
  SUMMARY
============================================================
  Chain:                   Paseo People
  Storage:                 Resources.Consumers
  Total entries:           37022
  Manual decode RSS delta: 120.5 MB
  Per-entry overhead:      ~3.3 KB
============================================================
```

## Environment

- `polkadot-api`: 2.1.0
- `@polkadot-api/metadata-builders`: 0.14.1
- `@polkadot-api/substrate-bindings`: 0.20.1
- Node.js: 24+
- Chain: Paseo People (`wss://paseo-people-next-rpc.polkadot.io`)
- Storage: `Resources.Consumers` (~37k entries, Blake2_128Concat hasher, single `AccountId32` key)

## Impact

Any daemon or service that periodically calls `getEntries()` on a storage map with tens of thousands of entries will see multi-GB RSS spikes. For our username indexer, this causes 100-200 MB spikes every 5 minutes on a pod with a 512 MB memory limit, triggering OOM kills.

## Suggested improvements

1. **Eliminate `codec.enc(result[i]).length` round-trip in `dynamic-builder.js`**: The hasher and key type sizes are known at build time. Re-encoding just to measure byte length is unnecessary.

2. **Batch or yield during `keys.dec()` in `getEntries()`**: The synchronous `.map()` prevents GC from reclaiming transient allocations across 37k entries.

3. **Reduce intermediate allocations in key decoding**: Each `fromHex` → `toInternalBytes` creates multiple wrapper objects that could be pooled or avoided.
