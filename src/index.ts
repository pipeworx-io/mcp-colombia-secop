interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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
 * SECOP II publishes drafts into the same table as real contracts, and the
 * draft rows have a NULL date. Socrata sorts NULLs FIRST on `ORDER BY ... DESC`,
 * so an unguarded "most recent first" search leads with unsigned `Borrador`
 * junk — 424,153 of the contract rows have no `fecha_de_firma` at all. Both
 * searches therefore require the sort column to be non-NULL by default;
 * `include_unsigned` / `include_unpublished` opt back in.
 *
 * All tools return shaped, LLM-friendly objects (not raw API passthrough) and
 * never throw — fetch/parse failures resolve to { error }.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Colombia SECOP');
}

const BASE = 'https://www.datos.gov.co';
const UA = 'pipeworx/1.0 (+https://pipeworx.io)';

// SECOP II datasets on datos.gov.co (verified live).
const PROCESOS_ID = 'p6dx-8zbt'; // SECOP II - Procesos de Contratación
const CONTRATOS_ID = 'jbjy-vk9h'; // SECOP II - Contratos electrónicos

/**
 * `tipo_de_contrato` is a clean facet, not free text. Enumerated live from the
 * contracts dataset, 24 distinct values. Filtering on it is the
 * right instrument for "works contracts" / "consultancy" questions — matching
 * the word "obra" as free text instead returns service contracts whose
 * description merely mentions it.
 */
const CONTRACT_TYPES = [
  'Prestación de servicios',
  'Decreto 092 de 2017',
  'Suministros',
  'Otro',
  'Compraventa',
  'Obra',
  'Arrendamiento de inmuebles',
  'Seguros',
  'Interventoría',
  'Consultoría',
  'Comodato',
  'Arrendamiento de muebles',
  'Servicios financieros',
  'Acuerdo Marco de Precios',
  'Acuerdo de cooperación',
  'Operaciones de Crédito Público',
  'Venta muebles',
  'Concesión',
  'Negocio fiduciario',
  'Comisión',
  'Venta inmuebles',
  'Asociación Público Privada',
  'No Definido',
  'No Especificado',
];

/**
 * The tools are described in English, so callers reach for English category
 * words. Map them onto the Spanish facet rather than letting an English
 * `contract_type` fall through to a silent zero.
 */
const CONTRACT_TYPE_ALIASES: Record<string, string> = {
  works: 'Obra',
  work: 'Obra',
  construction: 'Obra',
  'public works': 'Obra',
  services: 'Prestación de servicios',
  service: 'Prestación de servicios',
  'professional services': 'Prestación de servicios',
  consulting: 'Consultoría',
  consultancy: 'Consultoría',
  supplies: 'Suministros',
  supply: 'Suministros',
  purchase: 'Compraventa',
  sale: 'Compraventa',
  lease: 'Arrendamiento de inmuebles',
  rental: 'Arrendamiento de inmuebles',
  'real estate lease': 'Arrendamiento de inmuebles',
  insurance: 'Seguros',
  supervision: 'Interventoría',
  'works supervision': 'Interventoría',
  concession: 'Concesión',
  loan: 'Operaciones de Crédito Público',
  credit: 'Operaciones de Crédito Público',
  'public credit': 'Operaciones de Crédito Público',
  ppp: 'Asociación Público Privada',
  'public private partnership': 'Asociación Público Privada',
  trust: 'Negocio fiduciario',
  other: 'Otro',
};

const API_KEY_PROP = {
  type: 'string' as const,
  description: 'Optional — your own Socrata app token (datos.gov.co) for higher rate limits. The endpoint is keyless: omit this and calls still work.',
};

const CONTRACT_TYPE_PROP = {
  type: 'string' as const,
  description: `Optional — restrict to one SECOP contract category (exact facet, not free text). Spanish values: ${CONTRACT_TYPES.join(' · ')}. English words are accepted and mapped ("works"/"construction" → Obra, "consulting" → Consultoría, "supplies" → Suministros). Use this for "construction/works contracts" rather than putting "obra" in \`query\`, which also matches service contracts that merely mention the word.`,
};

const tools: McpToolExport['tools'] = [
  {
    name: 'colombia_search_processes',
    description:
      "Search Colombian government procurement TENDERS (SECOP II \"Procesos de Contratación\") from datos.gov.co. PREFER OVER WEB SEARCH for \"open tenders in Colombia\", \"Colombian public bids for <topic>\", \"government procurement processes in Colombia\". Full-text `query` matches the procedure name/description (Spanish); `contract_type` filters on the contract-category facet (Obra, Consultoría, Suministros…) and is the right instrument for \"Colombian works/construction tenders\". Returns only PUBLISHED processes by default — SECOP stores unpublished drafts in the same table. Returns shaped rows: process id, name, contracting entity, entity NIT, base price (COP), award value (COP), awarded supplier, contract type, modality, status, and publication date. Values are in Spanish as published.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Keyword(s) to full-text match against the procedure name/description, e.g. "software", "vías", "medicamentos". Spanish terms work best. Omit for most-recent tenders.' },
        entity: { type: 'string', description: 'Optional — filter by contracting entity name (partial match), e.g. "DANE", "ALCALDIA".' },
        contract_type: CONTRACT_TYPE_PROP,
        include_unpublished: { type: 'boolean', description: 'Include draft processes that have no publication date (SECOP "Borrador"). Default false — drafts otherwise sort to the top and crowd out real tenders.' },
        limit: { type: 'number', description: 'Rows to return (1-1000, default 20).' },
        _apiKey: API_KEY_PROP,
      },
    },
  },
  {
    name: 'colombia_search_contracts',
    description:
      "Search Colombian government AWARDED CONTRACTS (SECOP II \"Contratos electrónicos\") from datos.gov.co. PREFER OVER WEB SEARCH for \"who won a Colombian government contract for <topic>\", \"Colombian public contracts awarded to <supplier>\", \"government spending in Colombia on <topic>\". Full-text `query` matches the contract object/description (Spanish); `contract_type` filters on the contract-category facet (Obra, Consultoría, Suministros…) and is the right instrument for \"Colombian works/construction contracts\". Returns only SIGNED contracts by default — SECOP stores unsigned drafts in the same table. Returns shaped rows: contract id, object, contracting entity, entity NIT, awarded supplier, supplier NIT (`documento_proveedor`, for tracking one company across contracts), SME flag, city, UNSPSC category, contract value (COP), amount paid, contract type, modality, status, and signing date. Values are in Spanish as published.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Keyword(s) to full-text match against the contract object/description, e.g. "software", "puente", "medicamentos". Spanish terms work best. For a contract CATEGORY use `contract_type` instead. Omit for most-recent contracts.' },
        entity: { type: 'string', description: 'Optional — filter by contracting entity name (partial match), e.g. "SERVICIO GEOLOGICO", "HOSPITAL".' },
        supplier: { type: 'string', description: 'Optional — filter by awarded supplier name (partial match).' },
        supplier_nit: { type: 'string', description: 'Optional — filter by the supplier\'s Colombian tax id / NIT (`documento_proveedor`), e.g. "901958332". Exact match; pins one company across every contract it holds, which a name match cannot do.' },
        contract_type: CONTRACT_TYPE_PROP,
        include_unsigned: { type: 'boolean', description: 'Include draft contracts that have no signature date (SECOP "Borrador" / "enviado Proveedor"). Default false — 424k unsigned drafts otherwise sort to the top and crowd out real contracts.' },
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
  const res = await pwFetch(`${BASE}/resource/${id}.json?${params}`, { headers: headers(apiKey) });
  if (res.status === 429) throw new Error('upstream_throttled: datos.gov.co rate limit (HTTP 429). Pass _apiKey (Socrata app token) for higher limits.');
  // Socrata answers a THROTTLED request with 403 "Invalid app_token specified",
  // which is a lie about the cause: the token is valid and the very same one
  // succeeds on the next call. The quota is metered PER TOKEN, and Socrata hosts
  // every one of these city portals, so one platform token is a single budget
  // shared across all of them — a health sweep touching six cities in two seconds
  // drains it, and then each city separately reports its credential as invalid.
  // That reading has already sent one investigation hunting for a replacement
  // token to fix a token that was never broken. Say what is actually happening.
  //
  // But only when we actually sent a token we believe in. If the CALLER supplied
  // one, "the token is valid, just retry" is advice to retry forever against a
  // bad credential — and this endpoint needs no token at all, so the recovery is
  // to drop it, not to back off.
  if (res.status === 403) {
    const body = await res.clone().text().catch(() => '');
    if (/invalid app_token/i.test(body)) {
      throw new Error(
        apiKey
          ? 'invalid_api_key: datos.gov.co rejected the app token passed as _apiKey ("Invalid app_token specified"). This endpoint is KEYLESS — retry the same call with no _apiKey at all and it will succeed. Only pass a token you generated at datos.gov.co for higher rate limits.'
          : 'upstream_throttled: datos.gov.co refused this call with "Invalid app_token specified". That is Socrata\'s throttle response, not a credential problem — no token was sent and retrying usually succeeds. Socrata meters per portal it hosts, so calling several city packs at once shares one budget. Space the calls out and retry.',
      );
    }
  }
  if (!res.ok) {
    const body = await res.text().then((t) => t.slice(0, 200)).catch(() => '');
    throw new Error(`datos.gov.co: ${res.status} ${body}`.trim());
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

// datos.gov.co cannot serve `upper(col) like '%term%'` from an index — it is a
// full scan of a multi-million-row table, and with an `$order` stacked on top it
// stops coming back at all. Measured live 2026-08-31: the supplier search behind
// the SECOP golden question hung 4/4 past 70s having received ZERO bytes, while
// the very same table answered an indexed query in 0.57s, three times running.
// That is why this pack read as a datos.gov.co outage (fleet #740) while the
// portal was entirely healthy — the shape of our own query was the whole fault,
// so raising our timeout would only have bought a slower way to fail.
//
// Socrata's `$q` full-text parameter IS indexed, and sending it alongside the
// identical `$where` drops that same search to ~0.5s with a byte-identical body.
// `$q` can only ever REMOVE rows — every `$where` clause still runs — so a row it
// returns is always a genuine match, never a false positive.
//
// What `$q` can do is MISS, because it matches whole tokens: `concreto` does not
// find `CONCONCRETO`, and `Constru` does not find `CONSTRUCTORA` (both verified
// live at 0 rows against a set the LIKE does match). So when the indexed pass
// comes back empty we still pay for the exhaustive scan.
//
// THAT FALLBACK IS NOT A COMPLETENESS GUARANTEE, and an earlier version of this
// comment claimed it was ("never fewer results than before"). It only catches the
// ALL-OR-NOTHING miss. When `$q` matches SOME rows but not all, it returns a
// non-empty short answer and the fallback never fires. Measured live 2026-08-31 on
// this very dataset: `proveedor_adjudicado like '%TRANSPORTE%'` counts 5,084 rows,
// the same `$where` with `$q=TRANSPORTE` counts 5,071 — 13 rows dropped silently,
// because `TRANSPORTES` is a different token than `TRANSPORTE`. That is the trade
// this pack accepts: on datos.gov.co the honest alternative is not a complete
// answer, it is NO answer (61.7s and climbing, see above), so a 0.26% shortfall
// disclosed in `search_note` beats a request that never returns. Callers who need
// exactness have `supplier_nit`.
//
// DO NOT COPY THIS INTO OTHER SOCRATA PACKS WITHOUT MEASURING FIRST — the whole
// fleet's Socrata surface was surveyed for this shape on 2026-08-31 (fleet #962)
// and datos.gov.co turned out to be the only portal that needs it. Same query
// shape, same or larger tables, every other portal answering in seconds:
//   data.texas.gov      10,749,743 rows  0.47s      data.ct.gov     6,225,133  12.1s
//   data.transportation 4,494,695 rows   0.65-1.7s  data.oregon.gov   668,906   5.7s
//   data.ny.gov           275,763 rows   1.2s       cftc              288,151   0.8s
//   www.datos.gov.co    5,981,689 rows   19.7-61.7s  <-- the outlier, this pack
// Everywhere else the `$q` swap buys no speed a caller would notice and costs the
// silent under-count above (measured 422,441 -> 419,220 on the FMCSA census for
// `%TRANSPORT%`). It is a targeted remedy for one sick portal, not a house style.
const APPROX_ORDER_NOTE =
  'This term had to be answered by an exhaustive scan, which datos.gov.co cannot sort without timing out, so these rows were ranked here from a capped sample of the matches rather than by the full dataset. Treat the ordering as indicative, not as the definitive top results; narrow the search (add an entity, a contract type, or supplier_nit) for an exactly-ranked answer.';

const INDEXED_SEARCH_NOTE =
  'Matched using the datos.gov.co full-text index, which matches whole words. A term that appears only mid-word — "concreto" inside "CONCONCRETO" — is not reachable this way; search the complete word, or filter by an exact identifier (supplier_nit) for a guaranteed-complete lookup.';

async function socrataSearch(
  id: string,
  params: URLSearchParams,
  terms: (string | null | undefined)[],
  apiKey?: string,
): Promise<{ rows: unknown[]; indexed: boolean; orderingApproximate?: boolean }> {
  const q = terms.filter((t): t is string => !!t).join(' ').trim();
  if (!q) return { rows: await socrataGet(id, params, apiKey), indexed: false };

  const fast = new URLSearchParams(params);
  fast.set('$q', q);
  const rows = await socrataGet(id, fast, apiKey);
  if (rows.length) return { rows, indexed: true };

  // Empty on the indexed pass. That is either a genuinely empty result or a
  // substring the token index cannot see, and only the full scan tells them
  // apart — so spend it rather than silently under-report.
  //
  // But spend it WITHOUT the `$order`, or this fallback walks straight back into
  // the hang the `$q` pass exists to avoid. That is not hypothetical: it is what
  // the default supplier search still did after the first fix shipped. Measured
  // live 2026-08-31, `supplier=Ecopetrol`, which is the shape of the #740 golden
  // question — the indexed pass returns [] (every Ecopetrol row the token index
  // can see has a NULL fecha_de_firma, and the tool adds `fecha_de_firma IS NOT
  // NULL` by default), so the fallback ran, and the fallback WITH `$order` took
  // 64.5s against 4.9s without it. The gateway gives a tool 25s, so callers got
  // `upstream_down: Colombia SECOP did not respond within 25s` — the pack blaming
  // a healthy portal for our own query, which is the exact failure #740 was filed
  // about. Every genuinely-empty search hit this, not just the exotic mid-word
  // ones, because a legitimately empty result reaches the fallback too.
  //
  // Dropping `$order` means Socrata hands back an ARBITRARY page of matches
  // rather than the top ones, so we over-fetch and sort here to approximate it.
  // The result can still differ from a true server-side ordering when a term has
  // more matches than the over-fetch cap; `ordering_approximate` says so rather
  // than letting a partial page read as the definitive newest. Same remedy
  // `property-records` already uses on the SF roll for the same reason.
  const slow = new URLSearchParams(params);
  const order = slow.get('$order');
  slow.delete('$order');
  const limit = Number(slow.get('$limit')) || 20;
  const overFetch = Math.min(Math.max(limit * 20, 100), 1000);
  slow.set('$limit', String(overFetch));

  const scanned = await socrataGet(id, slow, apiKey);
  const sorted = order ? sortRowsBy(scanned, order) : scanned;
  return {
    rows: sorted.slice(0, limit),
    indexed: false,
    orderingApproximate: !!order && scanned.length >= overFetch,
  };
}

// Client-side stand-in for a `$order` we could not afford to send. Handles the
// single-key "field DESC" / "field ASC" forms this pack builds; anything more
// exotic is left in upstream order rather than silently mis-sorted.
function sortRowsBy(rows: unknown[], order: string): unknown[] {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(ASC|DESC)?\s*$/i.exec(order);
  if (!m) return rows;
  const field = m[1];
  const dir = (m[2] ?? 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = (a as Record<string, unknown>)?.[field];
    const bv = (b as Record<string, unknown>)?.[field];
    // Socrata sorts NULLs first on DESC; keep them last here, since the callers
    // that set an $order are ranking and a NULL is never the answer they want.
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return String(av) < String(bv) ? -dir : String(av) > String(bv) ? dir : 0;
  });
}

// SoQL string literals must have single quotes doubled to escape them.
function soqlLiteral(v: string): string {
  return v.replace(/'/g, "''");
}

function likeClause(col: string, kw: string): string {
  return `upper(${col}) like upper('%${soqlLiteral(kw)}%')`;
}

// Accent- and case-blind, so "consultoria"/"CONSULTORÍA"/"consulting" all land.
function foldKey(v: string): string {
  return v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

const CONTRACT_TYPE_BY_KEY = new Map<string, string>();
for (const t of CONTRACT_TYPES) CONTRACT_TYPE_BY_KEY.set(foldKey(t), t);
for (const [alias, canonical] of Object.entries(CONTRACT_TYPE_ALIASES)) CONTRACT_TYPE_BY_KEY.set(foldKey(alias), canonical);

/** Resolve caller input to an exact facet value, or report what IS valid. */
function resolveContractType(v: string): { value: string } | { error: string } {
  const hit = CONTRACT_TYPE_BY_KEY.get(foldKey(v));
  if (hit) return { value: hit };
  return {
    error: `unknown_contract_type: "${v}" is not a SECOP contract category. \`contract_type\` is an exact facet — valid values are: ${CONTRACT_TYPES.join(' · ')} (English "works"/"consulting"/"supplies" etc. are also accepted). To search words inside the contract description instead, pass them as \`query\`.`,
  };
}

function urlOf(row: Record<string, unknown>): string | null {
  const u = row.urlproceso;
  if (u && typeof u === 'object' && 'url' in u) return String((u as { url?: unknown }).url ?? '') || null;
  return null;
}

/** Zero rows is ambiguous here — say which filters were actually applied. */
function emptyHint(applied: Record<string, unknown>): string {
  const named = Object.entries(applied)
    .filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return `No rows matched ${named.length ? named.join(' AND ') : 'this search'}. SECOP text is published in SPANISH, so an English \`query\` matches nothing even when the data is there — try the Spanish term ("obra", "medicamentos", "vías"). For a contract CATEGORY use \`contract_type\` rather than \`query\`. Drafts are excluded by default; set include_unsigned/include_unpublished to see them.`;
}

async function searchProcesses(args: Record<string, unknown>, apiKey?: string): Promise<unknown> {
  const query = strArg(args.query);
  const entity = strArg(args.entity);
  const rawType = strArg(args.contract_type);
  const includeUnpublished = args.include_unpublished === true;
  const limit = Math.min(1000, Math.max(1, Number(args.limit) || 20));

  let contractType: string | null = null;
  if (rawType) {
    const r = resolveContractType(rawType);
    if ('error' in r) return { error: r.error };
    contractType = r.value;
  }

  const p = new URLSearchParams();
  const clauses: string[] = [];
  if (query) clauses.push(`(${likeClause('nombre_del_procedimiento', query)} OR ${likeClause('descripci_n_del_procedimiento', query)})`);
  if (entity) clauses.push(likeClause('entidad', entity));
  if (contractType) clauses.push(`tipo_de_contrato='${soqlLiteral(contractType)}'`);
  // Without this, Socrata's NULLs-first DESC ordering leads every search with
  // unpublished drafts.
  if (!includeUnpublished) clauses.push('fecha_de_publicacion_del IS NOT NULL');
  if (clauses.length) p.set('$where', clauses.join(' AND '));
  p.set('$order', 'fecha_de_publicacion_del DESC');
  p.set('$limit', String(limit));

  const { rows, indexed, orderingApproximate } = await socrataSearch(PROCESOS_ID, p, [query, entity], apiKey);
  const processes = rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: row.id_del_proceso ?? null,
      reference: row.referencia_del_proceso ?? null,
      name: row.nombre_del_procedimiento ?? null,
      entity: row.entidad ?? null,
      entity_nit: row.nit_entidad ?? null,
      department: row.departamento_entidad ?? null,
      city: row.ciudad_entidad ?? null,
      base_price_cop: row.precio_base ?? null,
      award_value_cop: row.valor_total_adjudicacion ?? null,
      awarded: row.adjudicado ?? null,
      supplier: row.nombre_del_proveedor ?? null,
      supplier_nit: row.nit_del_proveedor_adjudicado ?? null,
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
    contract_type: contractType,
    contract_type_input: rawType ?? null,
    published_only: !includeUnpublished,
    count: processes.length,
    dataset: PROCESOS_ID,
    source: 'SECOP II Procesos de Contratación (datos.gov.co)',
    processes,
    ...(indexed ? { search_note: INDEXED_SEARCH_NOTE } : {}),
    ...(orderingApproximate ? { ordering_approximate: true, ordering_note: APPROX_ORDER_NOTE } : {}),
    ...(processes.length ? {} : { hint: emptyHint({ query, entity, contract_type: contractType, published_only: !includeUnpublished }) }),
  };
}

async function searchContracts(args: Record<string, unknown>, apiKey?: string): Promise<unknown> {
  const query = strArg(args.query);
  const entity = strArg(args.entity);
  const supplier = strArg(args.supplier);
  const supplierNit = strArg(args.supplier_nit);
  const rawType = strArg(args.contract_type);
  const includeUnsigned = args.include_unsigned === true;
  const limit = Math.min(1000, Math.max(1, Number(args.limit) || 20));

  let contractType: string | null = null;
  if (rawType) {
    const r = resolveContractType(rawType);
    if ('error' in r) return { error: r.error };
    contractType = r.value;
  }

  const p = new URLSearchParams();
  const clauses: string[] = [];
  if (query) clauses.push(`(${likeClause('objeto_del_contrato', query)} OR ${likeClause('descripcion_del_proceso', query)})`);
  if (entity) clauses.push(likeClause('nombre_entidad', entity));
  if (supplier) clauses.push(likeClause('proveedor_adjudicado', supplier));
  if (supplierNit) clauses.push(`documento_proveedor='${soqlLiteral(supplierNit)}'`);
  if (contractType) clauses.push(`tipo_de_contrato='${soqlLiteral(contractType)}'`);
  // 424,153 contract rows have a NULL fecha_de_firma. Socrata sorts NULLs FIRST
  // on DESC, so without this guard every default search returns nothing but
  // unsigned Borrador rows.
  if (!includeUnsigned) clauses.push('fecha_de_firma IS NOT NULL');
  if (clauses.length) p.set('$where', clauses.join(' AND '));
  p.set('$order', 'fecha_de_firma DESC');
  p.set('$limit', String(limit));

  const { rows, indexed, orderingApproximate } = await socrataSearch(CONTRATOS_ID, p, [query, entity, supplier], apiKey);
  const contracts = rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: row.id_contrato ?? null,
      reference: row.referencia_del_contrato ?? null,
      object: row.objeto_del_contrato ?? null,
      entity: row.nombre_entidad ?? null,
      entity_nit: row.nit_entidad ?? null,
      department: row.departamento ?? null,
      city: row.ciudad ?? null,
      sector: row.sector ?? null,
      supplier: row.proveedor_adjudicado ?? null,
      supplier_nit: row.documento_proveedor ?? null,
      supplier_is_sme: row.es_pyme ?? null,
      unspsc_category: row.codigo_de_categoria_principal ?? null,
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
    supplier_nit: supplierNit ?? null,
    contract_type: contractType,
    contract_type_input: rawType ?? null,
    signed_only: !includeUnsigned,
    count: contracts.length,
    dataset: CONTRATOS_ID,
    source: 'SECOP II Contratos electrónicos (datos.gov.co)',
    contracts,
    ...(indexed ? { search_note: INDEXED_SEARCH_NOTE } : {}),
    ...(orderingApproximate ? { ordering_approximate: true, ordering_note: APPROX_ORDER_NOTE } : {}),
    ...(contracts.length ? {} : { hint: emptyHint({ query, entity, supplier, supplier_nit: supplierNit, contract_type: contractType, signed_only: !includeUnsigned }) }),
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
