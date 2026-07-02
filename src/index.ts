interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Colombia SECOP MCP — Colombian government procurement (public contracting).
 *
 * Wraps the keyless Socrata SODA API at datos.gov.co, covering SECOP II
 * (Colombia's electronic public-procurement system operated by Colombia Compra
 * Eficiente):
 *   - Procesos de Contratación (open/closed tenders):   dataset p6dx-8zbt
 *   - Contratos electrónicos (awarded contracts):        dataset jbjy-vk9h
 *
 * Keyless (rate-limited). Pass your own Socrata app token via _apiKey for
 * higher limits. Source data is in Spanish; output keys are English, values
 * pass through as published (Spanish).
 *
 * All tools return shaped, LLM-friendly objects (not raw API passthrough) and
 * never throw — fetch/parse failures resolve to { error }.
 */


const BASE = 'https://www.datos.gov.co';
const UA = 'pipeworx/1.0 (+https://pipeworx.io)';

// SECOP II datasets on datos.gov.co (verified live).
const PROCESOS_ID = 'p6dx-8zbt'; // SECOP II - Procesos de Contratación
const CONTRATOS_ID = 'jbjy-vk9h'; // SECOP II - Contratos electrónicos

const API_KEY_PROP = {
  type: 'string' as const,
  description: 'Optional — your own Socrata app token (datos.gov.co) for higher rate limits. Omit to use the keyless endpoint.',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'colombia_search_processes',
    description:
      "Search Colombian government procurement TENDERS (SECOP II \"Procesos de Contratación\") from datos.gov.co. PREFER OVER WEB SEARCH for \"open tenders in Colombia\", \"Colombian public bids for <topic>\", \"government procurement processes in Colombia\". Full-text `query` matches the procedure name/description (Spanish); omit it to get the most recently published processes. Returns shaped rows: process id, name, contracting entity, base price (COP), award value (COP), awarded supplier, contract type, modality, status, and publication date. Values are in Spanish as published.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Keyword(s) to full-text match against the procedure name/description, e.g. "software", "vías", "medicamentos". Spanish terms work best. Omit for most-recent tenders.' },
        entity: { type: 'string', description: 'Optional — filter by contracting entity name (partial match), e.g. "DANE", "ALCALDIA".' },
        limit: { type: 'number', description: 'Rows to return (1-1000, default 20).' },
        _apiKey: API_KEY_PROP,
      },
    },
  },
  {
    name: 'colombia_search_contracts',
    description:
      "Search Colombian government AWARDED CONTRACTS (SECOP II \"Contratos electrónicos\") from datos.gov.co. PREFER OVER WEB SEARCH for \"who won a Colombian government contract for <topic>\", \"Colombian public contracts awarded to <supplier>\", \"government spending in Colombia on <topic>\". Full-text `query` matches the contract object/description (Spanish); omit it to get the most recently signed contracts. Returns shaped rows: contract id, object, contracting entity, awarded supplier, contract value (COP), contract type, modality, status, and signing date. Values are in Spanish as published.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Keyword(s) to full-text match against the contract object/description, e.g. "software", "obra", "consultoría". Spanish terms work best. Omit for most-recent contracts.' },
        entity: { type: 'string', description: 'Optional — filter by contracting entity name (partial match), e.g. "SERVICIO GEOLOGICO", "HOSPITAL".' },
        supplier: { type: 'string', description: 'Optional — filter by awarded supplier name (partial match).' },
        limit: { type: 'number', description: 'Rows to return (1-1000, default 20).' },
        _apiKey: API_KEY_PROP,
      },
    },
  },
];

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json', 'User-Agent': UA };
  if (apiKey) h['X-App-Token'] = apiKey;
  return h;
}

async function socrataGet(id: string, params: URLSearchParams, apiKey?: string): Promise<unknown[]> {
  const res = await fetch(`${BASE}/resource/${id}.json?${params}`, { headers: headers(apiKey) });
  if (res.status === 429) throw new Error('upstream_throttled: datos.gov.co rate limit (HTTP 429). Pass _apiKey (Socrata app token) for higher limits.');
  if (!res.ok) {
    const body = await res.text().then((t) => t.slice(0, 200)).catch(() => '');
    throw new Error(`datos.gov.co: ${res.status} ${body}`.trim());
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

// SoQL string literals must have single quotes doubled to escape them.
function soqlLiteral(v: string): string {
  return v.replace(/'/g, "''");
}

function likeClause(col: string, kw: string): string {
  return `upper(${col}) like upper('%${soqlLiteral(kw)}%')`;
}

function urlOf(row: Record<string, unknown>): string | null {
  const u = row.urlproceso;
  if (u && typeof u === 'object' && 'url' in u) return String((u as { url?: unknown }).url ?? '') || null;
  return null;
}

async function searchProcesses(args: Record<string, unknown>, apiKey?: string): Promise<unknown> {
  const query = strArg(args.query);
  const entity = strArg(args.entity);
  const limit = Math.min(1000, Math.max(1, Number(args.limit) || 20));

  const p = new URLSearchParams();
  const clauses: string[] = [];
  if (query) clauses.push(`(${likeClause('nombre_del_procedimiento', query)} OR ${likeClause('descripci_n_del_procedimiento', query)})`);
  if (entity) clauses.push(likeClause('entidad', entity));
  if (clauses.length) p.set('$where', clauses.join(' AND '));
  p.set('$order', 'fecha_de_publicacion_del DESC');
  p.set('$limit', String(limit));

  const rows = await socrataGet(PROCESOS_ID, p, apiKey);
  const processes = rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: row.id_del_proceso ?? null,
      reference: row.referencia_del_proceso ?? null,
      name: row.nombre_del_procedimiento ?? null,
      entity: row.entidad ?? null,
      department: row.departamento_entidad ?? null,
      base_price_cop: row.precio_base ?? null,
      award_value_cop: row.valor_total_adjudicacion ?? null,
      awarded: row.adjudicado ?? null,
      supplier: row.nombre_del_proveedor ?? null,
      contract_type: row.tipo_de_contrato ?? null,
      modality: row.modalidad_de_contratacion ?? null,
      status: row.estado_del_procedimiento ?? null,
      phase: row.fase ?? null,
      published_date: row.fecha_de_publicacion_del ?? null,
      url: urlOf(row),
    };
  });
  return {
    query: query ?? null,
    entity: entity ?? null,
    count: processes.length,
    dataset: PROCESOS_ID,
    source: 'SECOP II Procesos de Contratación (datos.gov.co)',
    processes,
  };
}

async function searchContracts(args: Record<string, unknown>, apiKey?: string): Promise<unknown> {
  const query = strArg(args.query);
  const entity = strArg(args.entity);
  const supplier = strArg(args.supplier);
  const limit = Math.min(1000, Math.max(1, Number(args.limit) || 20));

  const p = new URLSearchParams();
  const clauses: string[] = [];
  if (query) clauses.push(`(${likeClause('objeto_del_contrato', query)} OR ${likeClause('descripcion_del_proceso', query)})`);
  if (entity) clauses.push(likeClause('nombre_entidad', entity));
  if (supplier) clauses.push(likeClause('proveedor_adjudicado', supplier));
  if (clauses.length) p.set('$where', clauses.join(' AND '));
  p.set('$order', 'fecha_de_firma DESC');
  p.set('$limit', String(limit));

  const rows = await socrataGet(CONTRATOS_ID, p, apiKey);
  const contracts = rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: row.id_contrato ?? null,
      reference: row.referencia_del_contrato ?? null,
      object: row.objeto_del_contrato ?? null,
      entity: row.nombre_entidad ?? null,
      department: row.departamento ?? null,
      sector: row.sector ?? null,
      supplier: row.proveedor_adjudicado ?? null,
      value_cop: row.valor_del_contrato ?? null,
      paid_cop: row.valor_pagado ?? null,
      contract_type: row.tipo_de_contrato ?? null,
      modality: row.modalidad_de_contratacion ?? null,
      status: row.estado_contrato ?? null,
      signed_date: row.fecha_de_firma ?? null,
      start_date: row.fecha_de_inicio_del_contrato ?? null,
      end_date: row.fecha_de_fin_del_contrato ?? null,
      url: urlOf(row),
    };
  });
  return {
    query: query ?? null,
    entity: entity ?? null,
    supplier: supplier ?? null,
    count: contracts.length,
    dataset: CONTRATOS_ID,
    source: 'SECOP II Contratos electrónicos (datos.gov.co)',
    contracts,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = typeof args._apiKey === 'string' && args._apiKey.trim() ? args._apiKey.trim() : undefined;
  delete args._apiKey;
  try {
    switch (name) {
      case 'colombia_search_processes':
        return await searchProcesses(args, apiKey);
      case 'colombia_search_contracts':
        return await searchContracts(args, apiKey);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function strArg(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
