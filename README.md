# `keys.dec()` allocates ~500x more memory than the raw SCALE data it decodes

## Description

Calling `typedApi.query.Resources.Consumers.getEntries()` on the Paseo People chain (~37k entries) causes a **2 GB RSS spike**. The same data decoded with manual hex-slicing of storage keys uses **120 MB** — a 17x difference.

The root cause is `keys.dec()` in `storage.js` line 159. It's called inside a synchronous `.map()` over all entries with no GC yield points:

```js
const decodedValues = values.map(({ key, value }) => ({
  keyArgs: codecs.keys.dec(key), // ← ~57 KB of transient allocations per key
  value: codecs.value.dec(value),
}))
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
[baseline                    ] RSS:   108.5 MB (+0.0 MB)
[typed api created           ] RSS:   114.5 MB (+6.0 MB)

Calling typedApi.query.Resources.Consumers.getEntries()...

[before getEntries()         ] RSS:   115.8 MB (+7.3 MB)
[after getEntries()          ] RSS:  2176.7 MB (+2068.2 MB)  returned 37035 entries
[after gc()                  ] RSS:  2178.5 MB (+2069.9 MB)

============================================================
  SUMMARY
============================================================
  Chain:                   Paseo People
  Storage:                 Resources.Consumers
  Total entries:           37035
  getEntries() RSS delta:  2060.9 MB
  Per-entry overhead:      ~57.0 KB
  Serialized result size:  11.2 MB
============================================================
```

### Optimized output (manual hex-slice, same data)

```
[baseline                    ] RSS:   114.7 MB (+0.0 MB)
[client created              ] RSS:   120.7 MB (+6.0 MB)
[codecs ready                ] RSS:   138.3 MB (+23.6 MB)

Fetching Resources.Consumers with manual key decode...

[before fetch                ] RSS:   138.4 MB (+23.7 MB)
[after fetch                 ] RSS:   258.7 MB (+144.0 MB)  returned 37037 entries
[after gc()                  ] RSS:   258.5 MB (+143.9 MB)

============================================================
  SUMMARY
============================================================
  Chain:                   Paseo People
  Storage:                 Resources.Consumers
  Total entries:           37037
  Manual decode RSS delta: 120.3 MB
  Per-entry overhead:      ~3.3 KB
  Serialized result size:  10.8 MB
============================================================
```

## The numbers

Both scripts produce the same decoded result. `v8.serialize()` confirms the final data is ~11 MB in both cases.

| | Serialized result | RSS delta | Ratio |
|---|---|---|---|
| `getEntries()` (typed API) | 11.2 MB | 2,061 MB | **184x** the actual data |
| Manual hex-slice + `value.dec()` | 10.8 MB | 120 MB | **11x** the actual data |

The 11 MB is the real cost of holding 37k decoded entries as JS objects. The 120 MB floor includes V8 object overhead (hidden classes, property arrays, string backing stores). The remaining ~1.9 GB on top is transient `keys.dec()` garbage that can never be collected — `getEntries()` calls `keys.dec()` inside a synchronous `.map()` with no GC yield points, so all 37k decode passes' allocations accumulate before V8 can reclaim anything.

## Environment

- `polkadot-api`: 2.1.0
- `@polkadot-api/metadata-builders`: 0.14.1
- `@polkadot-api/substrate-bindings`: 0.20.1
- Node.js: 24+
- Chain: Paseo People (`wss://paseo-people-next-rpc.polkadot.io`)
- Storage: `Resources.Consumers` (~37k entries, Blake2_128Concat hasher, single `AccountId32` key)
