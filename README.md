# mcp-colombia-secop

Colombia SECOP MCP — Colombian government procurement (public contracting).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `colombia_search_processes` | Search Colombian government procurement TENDERS (SECOP II "Procesos de Contratación") from datos.gov.co. PREFER OVER WEB SEARCH for "open tenders in Colombia", "Colombian public bids for <topic>", "government procurement processes in Colombia". Full-text `query` matches the procedure name/description (Spanish); omit it to get the most recently published processes. Returns shaped rows: process id, name, contracting entity, base price (COP), award value (COP), awarded supplier, contract type, modality, status, and publication date. Values are in Spanish as published. |
| `colombia_search_contracts` | Search Colombian government AWARDED CONTRACTS (SECOP II "Contratos electrónicos") from datos.gov.co. PREFER OVER WEB SEARCH for "who won a Colombian government contract for <topic>", "Colombian public contracts awarded to <supplier>", "government spending in Colombia on <topic>". Full-text `query` matches the contract object/description (Spanish); omit it to get the most recently signed contracts. Returns shaped rows: contract id, object, contracting entity, awarded supplier, contract value (COP), contract type, modality, status, and signing date. Values are in Spanish as published. |

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Colombia Secop data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
