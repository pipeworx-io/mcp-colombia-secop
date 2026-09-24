# @pipeworx/colombia-secop

Colombia SECOP MCP — Colombian government procurement (tenders and awarded contracts) from the keyless Socrata API at datos.gov.co.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

- `colombia_search_contracts(query, entity, supplier, supplier_nit, contract_type, include_unsigned, limit)` — awarded contracts (SECOP II "Contratos electrónicos", dataset `jbjy-vk9h`). Returns contract id, object, entity + entity NIT, supplier + supplier NIT, SME flag, city, UNSPSC category, value and amount paid (COP), type, modality, status, signing date.
- `colombia_search_processes(query, entity, contract_type, include_unpublished, limit)` — tenders (SECOP II "Procesos de Contratación", dataset `p6dx-8zbt`). Returns process id, name, entity + entity NIT, base price, award value, awarded supplier, type, modality, status, publication date.

## Auth

Keyless. `_apiKey` is optional — pass your own [Socrata app token](https://www.datos.gov.co/profile/edit/developer_settings) only if you want higher rate limits. There is no platform key and none is needed; a call with no token works.

## Gotchas

**Drafts share the table with real contracts, and they sort first.** 424,153 contract rows have a NULL `fecha_de_firma`, and Socrata orders NULLs *first* on `ORDER BY ... DESC`. An unguarded "most recent" search therefore returns nothing but unsigned `Borrador` / `enviado Proveedor` rows. Both tools require the sort column to be non-NULL by default; `include_unsigned` / `include_unpublished` opt back in.

**Use `contract_type`, not `query`, for a contract category.** `tipo_de_contrato` is a clean 24-value facet (`Obra` ≈ 52k contracts against ≈ 5.1M `Prestación de servicios`). Passing `"obra"` as free text LIKE-matches service contracts that merely mention the word. The argument accepts the Spanish facet values and maps common English ones (`works`/`construction` → `Obra`, `consulting` → `Consultoría`, `supplies` → `Suministros`); an unrecognised value returns `unknown_contract_type` listing the valid set rather than a silent zero.

**Text is published in Spanish.** An English `query` matches nothing even when the data is present, so a zero-result response carries a hint saying so.

**Socrata reports a throttle as `403 "Invalid app_token specified"`.** With no token sent that is the rate limit, not a credential problem — space the calls out and retry. If the caller *did* pass `_apiKey`, the pack instead reports `invalid_api_key` and tells them to drop the token, since the endpoint is keyless and retrying a bad token never succeeds.

**`documento_proveedor` (supplier NIT) is the durable supplier key.** Names vary across filings; the NIT pins one company across every contract it holds. It reads `"No Definido"` on rows where SECOP has no value.

## Data sources

- Contratos electrónicos: `https://www.datos.gov.co/resource/jbjy-vk9h.json`
- Procesos de Contratación: `https://www.datos.gov.co/resource/p6dx-8zbt.json`
- Portal: https://www.colombiacompra.gov.co/secop/secop-ii

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "colombia-secop": {
      "url": "https://gateway.pipeworx.io/colombia-secop/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/colombia-secop/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/colombia_search_processes \
  -H 'Content-Type: application/json' \
  -d '{"contract_type":"Obra","limit":20}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/colombia_search_processes`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "colombia-secop": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-colombia-secop"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-colombia-secop
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Colombia Secop data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
