/**
 * Channels, routes and per-route model settings — the storage half of
 * docs/feature/channel-model-route-plan.md §2–§5.
 *
 * A `Provider` row is a **channel**: one key on one platform. What used to be
 * the whole row — a base URL and a standard — is now one of its **routes**
 * (`Endpoint`), one per protocol family, each an address below the channel's
 * host. A `Model` picks one route as its current one (`activeRoute`); the
 * fields that change when the same model is spoken to in another protocol
 * (thinking, output cap, temperature, structured output, …) are kept per route
 * (`RouteProfile`).
 *
 * The one idea that keeps the other ~30 call sites unchanged: **the flat fields
 * are always the current route's.** `Provider.baseUrl` / `apiStandard` /
 * `authMode` / `safetySettings` are the primary route's (`normalizeChannel`),
 * a `Model`'s route fields are its active route's, and `providerFor(model,
 * providers)` hands back the channel *as seen through that model's route* — so
 * everything that read `provider.apiStandard` next to a model keeps reading the
 * right family without knowing routes exist. Only the settings drawers, the
 * list and the merge see the rest.
 *
 * Stored as two JSON columns rather than the two tables the plan first drew
 * (plan §11 P1–P4 记录 1): nothing ever queries a route by SQL, the upserts stay
 * one statement each (the config restore and the merge batch them through
 * `sqlTransaction` unchanged), and the old columns keep holding the current
 * route — so an older build reading this database sees exactly what it did.
 */

import type { Model, Provider } from "./configDb";
import type { GeminiSafetySettings } from "./safety";
import {
  authModesFor, familyOf, isCompatStandard, parseTextVerbosity,
  type ApiStandard, type AuthMode, type ProtocolFamily,
} from "./types";
import { platformDefaultPath, platformEndpoints, resolvePlatform, type PlatformId } from "./platforms";
import { parseReasoningEffort, parseThinkingCategory, parseThinkingDialect } from "./reasoning";
import { parseStructuredOutputMode } from "./jsonMode";
import { isPrivateNetworkUrl } from "../http";

/** Every family, in the order route strips and tables list them. */
export const ROUTE_FAMILIES: readonly ProtocolFamily[] = ["openai", "responses", "gemini", "anthropic"];

/** One route of a channel: a protocol family at an address. */
export interface Endpoint {
  family: ProtocolFamily;
  /** The vendor's own endpoint (`openai` / `anthropic` / `gemini` standards) — address locked. */
  official: boolean;
  /**
   * What follows the channel's host. Absent = the platform's convention
   * (`platformDefaultPath`) — stored as an override only, never as the
   * default copied in (§5.1.1), so a platform's convention changing moves every
   * route that never changed it. A value with a scheme (`https://…`) replaces
   * host and path both: some relays put one protocol on its own subdomain.
   */
  path?: string;
  /** Anthropic/Gemini-compat key header; absent = the protocol's own. */
  authMode?: AuthMode;
  /** Gemini only. */
  safetySettings?: GeminiSafetySettings;
}

/**
 * The model fields that change with the protocol (plan §3 table). Everything
 * else on a `Model` is the model's whatever route it takes.
 */
export interface RouteProfile {
  maxOutput?: number;
  temperature?: number;
  reasoningEffort?: Model["reasoningEffort"];
  thinkingCategory?: Model["thinkingCategory"];
  thinkingBudget?: number;
  thinkingDialect?: Model["thinkingDialect"];
  structuredOutput?: Model["structuredOutput"];
  textVerbosity?: Model["textVerbosity"];
  vlHighResolution?: boolean;
  probedAt?: number;
  probedContextSize?: number;
  probedMaxOutput?: number;
}

/** The keys of `RouteProfile`, as a list — what moves when a model switches route. */
export const ROUTE_PROFILE_KEYS = [
  "maxOutput", "temperature", "reasoningEffort", "thinkingCategory", "thinkingBudget", "thinkingDialect",
  "structuredOutput", "textVerbosity", "vlHighResolution", "probedAt", "probedContextSize", "probedMaxOutput",
] as const satisfies readonly (keyof RouteProfile)[];

// ─── Standards ⇄ families ────────────────────────────────────────────────────

const OFFICIAL_STANDARD: Record<ProtocolFamily, ApiStandard> = {
  openai: "openai",
  responses: "openai_responses",
  gemini: "gemini",
  anthropic: "anthropic",
};

/** The `ApiStandard` a route speaks — still what the four adapters dispatch on. */
export function standardOf(ep: Pick<Endpoint, "family" | "official">): ApiStandard {
  const official = OFFICIAL_STANDARD[ep.family];
  return ep.official ? official : (`${official}_compat` as ApiStandard);
}

/** Short badge text per family (§6.1: names, not numbers). */
export const ROUTE_SHORT: Record<ProtocolFamily, string> = {
  openai: "Chat", responses: "Resp", gemini: "Gemini", anthropic: "Anth",
};
/** Full badge text per family, for the wide places. */
export const ROUTE_LONG: Record<ProtocolFamily, string> = {
  openai: "Chat Completions", responses: "Responses", gemini: "Gemini", anthropic: "Anthropic",
};

// ─── Addresses ───────────────────────────────────────────────────────────────

/**
 * `scheme://host[:port]` and the rest, split on the raw string — not through
 * `URL`, which lower-cases the host and would make host + rest differ from the
 * original by a byte. A string with no scheme has no host: all of it is rest.
 */
export function splitBaseUrl(baseUrl: string): { host: string; rest: string } {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([\s\S]*)$/i.exec(baseUrl);
  return m ? { host: m[1], rest: m[2] } : { host: "", rest: baseUrl };
}

const isAbsolute = (path: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(path.trim());

/** The host a channel's routes hang off. */
export function channelHost(p: Pick<Provider, "host" | "baseUrl">): string {
  return p.host ?? splitBaseUrl(p.baseUrl).host;
}

/**
 * The base URL one route's requests go to — what `ConnOptions.baseUrl` has
 * always been, so the adapters' URL functions append their tails unchanged.
 * An official route with no override is empty: the vendor's address is the
 * adapter's constant, exactly as an official provider always stored it.
 */
export function endpointBaseUrl(
  channel: Pick<Provider, "host" | "baseUrl" | "platform" | "apiStandard">,
  ep: Endpoint,
): string {
  if (ep.path !== undefined && isAbsolute(ep.path)) return ep.path;
  if (ep.official) return ep.path ?? "";
  const platform = channelPlatform(channel);
  return channelHost(channel) + (ep.path ?? platformDefaultPath(platform, ep.family));
}

/** The channel's platform, resolved the way `listProviders` resolves it. */
function channelPlatform(p: Pick<Provider, "platform" | "baseUrl" | "apiStandard">): PlatformId {
  return resolvePlatform(p.platform, p.baseUrl, p.apiStandard);
}

/**
 * The one route a pre-routes row has: its own base URL and standard. The path
 * is stored only when it differs from the platform's convention, so recombining
 * `host + path` gives the stored base URL back byte for byte (§5.2 — the
 * migration changes no request).
 */
export function legacyEndpoint(p: Pick<Provider, "baseUrl" | "apiStandard" | "authMode" | "safetySettings" | "platform">): {
  host: string; endpoint: Endpoint;
} {
  const family = familyOf(p.apiStandard);
  const official = !isCompatStandard(p.apiStandard);
  const { host, rest } = splitBaseUrl(p.baseUrl);
  const platform = resolvePlatform(p.platform, p.baseUrl, p.apiStandard);
  let path: string | undefined;
  if (official) {
    // An official row stores no address; one that does (the vendor default,
    // written out) keeps it verbatim as an absolute override.
    path = p.baseUrl ? p.baseUrl : undefined;
  } else if (!host) {
    path = rest; // not a URL at all — kept whole, so nothing is lost
  } else {
    path = rest === platformDefaultPath(platform, family) ? undefined : rest;
  }
  return {
    host: official ? "" : host,
    endpoint: {
      family, official,
      ...(path !== undefined ? { path } : {}),
      ...(p.authMode ? { authMode: p.authMode } : {}),
      ...(p.safetySettings ? { safetySettings: p.safetySettings } : {}),
    },
  };
}

/** A channel's routes, primary first. A hand-built provider without any has its legacy one. */
export function channelEndpoints(p: Provider): Endpoint[] {
  return p.endpoints?.length ? p.endpoints : [legacyEndpoint(p).endpoint];
}

/**
 * Whether a channel may be saved and called without an API key: a model server
 * the author runs themselves. Two ways to be one — the Ollama platform (which
 * has no key on any host), or every route pointing at this machine or the local
 * network (`isPrivateNetworkUrl`), which is where an LM Studio on another box
 * lands as `custom`. A public host still needs one: there a missing key is a
 * typo, and saying so at save time beats a 401 mid-run.
 */
export function keyOptional(
  p: Pick<Provider, "host" | "baseUrl" | "platform" | "apiStandard" | "endpoints" | "authMode" | "safetySettings">,
): boolean {
  if (channelPlatform(p) === "ollama") return true;
  const eps = p.endpoints?.length ? p.endpoints : [legacyEndpoint(p).endpoint];
  return eps.every((ep) => isPrivateNetworkUrl(endpointBaseUrl(p, ep)));
}

/**
 * Bring a channel's flat fields in line with its primary route, and fill
 * `host` / `endpoints` on a row that predates them. Idempotent; every read and
 * every save goes through it, so "the flat fields are the primary route's" is
 * a fact rather than a convention.
 */
export function normalizeChannel(p: Provider): Provider {
  let host = p.host;
  let endpoints = p.endpoints?.length ? p.endpoints : undefined;
  if (!endpoints) {
    const legacy = legacyEndpoint(p);
    host = host ?? legacy.host;
    endpoints = [legacy.endpoint];
  }
  const primary = endpoints[0];
  const withHost = { ...p, host: host ?? "" };
  const apiStandard = standardOf(primary);
  const baseUrl = endpointBaseUrl({ ...withHost, apiStandard }, primary);
  return {
    ...withHost,
    endpoints,
    baseUrl,
    apiStandard,
    authMode: authModesFor(apiStandard).includes(primary.authMode as AuthMode) ? primary.authMode : undefined,
    safetySettings: primary.family === "gemini" ? primary.safetySettings : undefined,
    platform: resolvePlatform(p.platform, baseUrl, apiStandard),
  };
}

/**
 * The channel as one of its routes sees it: the flat fields replaced by that
 * route's. Undefined when the channel has no such route (removed since the
 * model picked it) — `resolveConn` names that failure on its own.
 */
export function routeProvider(p: Provider, family?: ProtocolFamily): Provider | undefined {
  const endpoints = channelEndpoints(p);
  const ep = family ? endpoints.find((e) => e.family === family) : endpoints[0];
  if (!ep) return undefined;
  const apiStandard = standardOf(ep);
  const baseUrl = endpointBaseUrl(p, ep);
  return {
    ...p,
    baseUrl,
    apiStandard,
    authMode: authModesFor(apiStandard).includes(ep.authMode as AuthMode) ? ep.authMode : undefined,
    safetySettings: ep.family === "gemini" ? ep.safetySettings : undefined,
    // The channel's platform, unless this route is an official one — then the
    // vendor is the platform (resolvePlatform), same as it is for a whole row.
    platform: resolvePlatform(p.platform, baseUrl, apiStandard),
  };
}

// ─── A model's routes ────────────────────────────────────────────────────────

/** The family a model's requests take: its pick, else the channel's primary route. */
export function activeFamily(m: Pick<Model, "activeRoute">, p: Provider): ProtocolFamily {
  const endpoints = channelEndpoints(p);
  return m.activeRoute && endpoints.some((e) => e.family === m.activeRoute)
    ? m.activeRoute
    : endpoints[0].family;
}

/**
 * A route pin a new row may keep on this channel: the pin when the channel has
 * that route, else none — the row then follows the primary route. Used for a
 * new channel's starter rows, pinned to a route the author may have removed
 * before saving; kept, such a pin is a row `resolveConn` refuses on every call.
 */
export function pinnableRoute(route: ProtocolFamily | undefined, endpoints: readonly Pick<Endpoint, "family">[]): ProtocolFamily | undefined {
  return route && endpoints.some((e) => e.family === route) ? route : undefined;
}

/**
 * The provider a model is served by, seen through the model's route. **Use this
 * rather than `providers.find(p => p.id === m.providerId)`** anywhere the
 * answer feeds a protocol question (family, platform, server tools, the wire):
 * the found row is the channel's primary route, which is not this model's once
 * it has switched.
 *
 * A model whose picked route the channel no longer has falls back to the
 * primary one here — the lists and estimates keep working; `resolveConn` is
 * where a request refuses it.
 */
export function providerFor(m: Pick<Model, "providerId" | "activeRoute">, providers: readonly Provider[]): Provider | undefined {
  const p = providers.find((x) => x.id === m.providerId);
  if (!p) return undefined;
  return routeProvider(p, activeFamily(m, p));
}

/** The route fields a model carries right now — its active route's profile. */
export function routeProfileOf(m: RouteProfile): RouteProfile {
  const out: RouteProfile = {};
  for (const k of ROUTE_PROFILE_KEYS) {
    if (m[k] !== undefined) (out as Record<string, unknown>)[k] = m[k];
  }
  return out;
}

/** A model with its route fields replaced — every key, so a field absent from `profile` is cleared. */
function withRouteProfile(m: Model, profile: RouteProfile): Model {
  const next = { ...m } as Record<string, unknown>;
  for (const k of ROUTE_PROFILE_KEYS) next[k] = profile[k];
  return next as unknown as Model;
}

/** The families a model has a profile for, current first, restricted to routes its channel still has. */
export function modelRouteFamilies(m: Model, p: Provider): ProtocolFamily[] {
  const offered = new Set(channelEndpoints(p).map((e) => e.family));
  const active = activeFamily(m, p);
  const others = Object.keys(m.routes ?? {}).filter(
    (f): f is ProtocolFamily => f !== active && offered.has(f as ProtocolFamily),
  );
  return [active, ...ROUTE_FAMILIES.filter((f) => others.includes(f))];
}

/**
 * Switch a model to another route of its channel. The current fields are
 * parked under the old family; the new family's are loaded — or nothing, for a
 * route never configured (invariant 3: **nothing is copied across**, because
 * the fields are per-family and an effort that means one thing on ② means
 * another or nothing on ④). The row's id never changes (invariant 1).
 */
export function switchModelRoute(m: Model, p: Provider, family: ProtocolFamily): Model {
  const current = activeFamily(m, p);
  if (family === current) return { ...m, activeRoute: family };
  const routes = { ...(m.routes ?? {}) };
  routes[current] = routeProfileOf(m);
  const next = routes[family] ?? {};
  delete routes[family];
  return {
    ...withRouteProfile(m, next),
    activeRoute: family,
    routes: Object.keys(routes).length ? routes : undefined,
  };
}

/** Forget a non-current route's profile. The current one cannot be dropped — switch first. */
export function dropModelRoute(m: Model, family: ProtocolFamily): Model {
  if (!m.routes?.[family]) return m;
  const routes = { ...m.routes };
  delete routes[family];
  return { ...m, routes: Object.keys(routes).length ? routes : undefined };
}

// ─── Parsing (DB rows and backups share these) ───────────────────────────────

const FAMILY_SET = new Set<string>(ROUTE_FAMILIES);
const isFamily = (v: unknown): v is ProtocolFamily => typeof v === "string" && FAMILY_SET.has(v);

/** Narrow a stored family; anything else is absent. */
export function parseRouteFamily(raw: unknown): ProtocolFamily | undefined {
  return isFamily(raw) ? raw : undefined;
}

function fromJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Narrow a stored route list, field by field. One route per family (a second
 * one is dropped — plan §9: same-family twins are two channels); an unknown
 * family is dropped. Empty → undefined, which reads as the legacy route.
 */
export function parseEndpoints(raw: unknown): Endpoint[] | undefined {
  const value = fromJson(raw);
  if (!Array.isArray(value)) return undefined;
  const out: Endpoint[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (!isFamily(r.family) || out.some((e) => e.family === r.family)) continue;
    const ep: Endpoint = { family: r.family, official: r.official === true };
    if (typeof r.path === "string") ep.path = r.path;
    const std = standardOf(ep);
    if (authModesFor(std).includes(r.authMode as AuthMode) && r.authMode !== "default") {
      ep.authMode = r.authMode as AuthMode;
    }
    if (ep.family === "gemini" && r.safetySettings && typeof r.safetySettings === "object") {
      ep.safetySettings = r.safetySettings as GeminiSafetySettings;
    }
    out.push(ep);
  }
  return out.length ? out : undefined;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Narrow one route profile the same way `rowToModel` narrows the flat columns. */
function parseRouteProfile(raw: unknown): RouteProfile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const p: RouteProfile = {
    maxOutput: num(r.maxOutput),
    temperature: num(r.temperature),
    reasoningEffort: parseReasoningEffort(r.reasoningEffort),
    thinkingCategory: parseThinkingCategory(r.thinkingCategory),
    thinkingBudget: num(r.thinkingBudget),
    thinkingDialect: parseThinkingDialect(r.thinkingDialect),
    structuredOutput: parseStructuredOutputMode(r.structuredOutput),
    textVerbosity: parseTextVerbosity(r.textVerbosity),
    vlHighResolution: r.vlHighResolution === true ? true : undefined,
    probedAt: num(r.probedAt),
    probedContextSize: num(r.probedContextSize),
    probedMaxOutput: num(r.probedMaxOutput),
  };
  return routeProfileOf(p);
}

/** Narrow a model's parked route profiles (every route but its current one). */
export function parseRouteProfiles(raw: unknown): Partial<Record<ProtocolFamily, RouteProfile>> | undefined {
  const value = fromJson(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Partial<Record<ProtocolFamily, RouteProfile>> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isFamily(k)) out[k] = parseRouteProfile(v);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The route list a brand-new channel on `platform` gets: everything the
 * platform serves (the add screen previews exactly this), except on `custom`,
 * where nothing is known and the author adds routes as they verify them.
 */
export function newChannelEndpoints(platform: PlatformId): Endpoint[] {
  const all = platformEndpoints(platform);
  const picked = platform === "custom" ? all.slice(0, 1) : all;
  return picked.map((e) => ({
    family: e.family,
    official: e.official === true,
    ...(e.authMode ? { authMode: e.authMode } : {}),
  }));
}

/**
 * Whether a channel's stored route list no longer matches its legacy columns —
 * an older build edited the row (it writes base_url / api_standard and knows
 * nothing of routes). The columns are then the newer truth for the primary
 * route; `listProviders` rebuilds it from them.
 */
export function legacyColumnsDiverged(p: Provider, endpoints: Endpoint[]): boolean {
  const primary = endpoints[0];
  const std = standardOf(primary);
  if (std !== p.apiStandard) return true;
  const base = endpointBaseUrl({ ...p, apiStandard: std }, primary);
  return base !== p.baseUrl;
}

/**
 * The base URL the writing build stored in the legacy column beside the route
 * list (`providerUpsert` puts it on the primary route). Absent on a list
 * written without it — `legacyColumnsDiverged` then answers alone.
 */
export function writtenBaseOf(raw: unknown): string | undefined {
  const value = fromJson(raw);
  if (!Array.isArray(value)) return undefined;
  const first = value[0] as Record<string, unknown> | undefined;
  return first && typeof first.writtenBase === "string" ? first.writtenBase : undefined;
}
