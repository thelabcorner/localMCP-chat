type Json = Record<string, unknown>;

export type ModelCapability = 'text' | 'image' | 'pdf' | 'audio' | 'video';

export interface OpenCodeModelInfo {
  providerID: string;
  modelID: string;
  name?: string;
  family?: string;
  tier: string;
  status?: string;
  releaseDate?: string;
  contextLimit?: number;
  outputLimit?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  capabilities?: {
    reasoning?: boolean;
    attachment?: boolean;
    toolcall?: boolean;
    input: string[];
    output: string[];
  };
  variants?: string[];
}

function record(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const MODALITIES = ['text', 'image', 'video', 'audio', 'pdf'] as const;

function modalities(model: Json): { input: string[]; output: string[] } | undefined {
  const capabilities = record(model.capabilities);
  const inputCaps = record(capabilities.input);
  const outputCaps = record(capabilities.output);
  if (Object.keys(inputCaps).length || Object.keys(outputCaps).length) {
    return {
      input: MODALITIES.filter(key => inputCaps[key] === true),
      output: MODALITIES.filter(key => outputCaps[key] === true),
    };
  }
  const published = record(model.modalities);
  if (!Object.keys(published).length) return undefined;
  return {
    input: Array.isArray(published.input) ? published.input.filter((x): x is string => typeof x === 'string') : [],
    output: Array.isArray(published.output) ? published.output.filter((x): x is string => typeof x === 'string') : [],
  };
}

export function tierForProvider(providerID: string, modelID = ''): string {
  if (providerID === 'opencode-go') return 'go';
  if (providerID === 'opencode') return /(^|-)(free|free-)/i.test(modelID) ? 'zen-free' : 'zen';
  return providerID;
}

export function normalizeProvider(providerID: string): string {
  const value = providerID.trim();
  const lower = value.toLowerCase();
  if (lower === 'go' || lower === 'opencode go') return 'opencode-go';
  if (lower === 'zen' || lower === 'zen-free' || lower === 'opencode zen') return 'opencode';
  return value;
}

export function providerDisplayName(providerID: string): string {
  if (providerID === 'opencode-go') return 'OpenCode Go';
  if (providerID === 'opencode') return 'OpenCode Zen';
  if (providerID === 'openrouter') return 'OpenRouter';
  if (providerID === 'workbuddy') return 'WorkBuddy';
  return providerID;
}

export function catalogFromProviderPayload(payload: unknown): {
  models: OpenCodeModelInfo[];
  connected: Set<string>;
  defaults: Record<string, unknown>;
  providers: Json[];
} {
  const body = record(payload);
  const providers = Array.isArray(body.all) ? body.all.map(record) : [];
  const connected = new Set(
    (Array.isArray(body.connected) ? body.connected : []).filter((x): x is string => typeof x === 'string'),
  );
  const defaults = record(body.default);
  const models: OpenCodeModelInfo[] = [];

  for (const provider of providers) {
    const providerID = typeof provider.id === 'string' ? provider.id : '';
    if (!providerID) continue;
    for (const [entryID, raw] of Object.entries(record(provider.models))) {
      const model = record(raw);
      const modelID = typeof model.id === 'string' && model.id ? model.id : entryID;
      const caps = record(model.capabilities);
      const mode = modalities(model);
      const cost = record(model.cost);
      const cache = record(cost.cache);
      const inputCost = finite(cost.input);
      const outputCost = finite(cost.output);
      const limit = record(model.limit);
      models.push({
        providerID,
        modelID,
        ...(typeof model.name === 'string' && model.name ? { name: model.name } : {}),
        ...(typeof model.family === 'string' && model.family ? { family: model.family } : {}),
        tier: tierForProvider(providerID, modelID),
        ...(typeof model.status === 'string' ? { status: model.status } : {}),
        ...(typeof model.release_date === 'string' ? { releaseDate: model.release_date } : {}),
        ...(finite(limit.context) !== undefined ? { contextLimit: finite(limit.context) } : {}),
        ...(finite(limit.output) !== undefined ? { outputLimit: finite(limit.output) } : {}),
        ...(inputCost !== undefined || outputCost !== undefined ? {
          cost: {
            input: inputCost ?? 0,
            output: outputCost ?? 0,
            ...(finite(cache.read ?? cost.cache_read) !== undefined ? { cacheRead: finite(cache.read ?? cost.cache_read) } : {}),
            ...(finite(cache.write ?? cost.cache_write) !== undefined ? { cacheWrite: finite(cache.write ?? cost.cache_write) } : {}),
          },
        } : {}),
        ...(mode || Object.keys(caps).length ? {
          capabilities: {
            reasoning: caps.reasoning === true,
            attachment: caps.attachment === true,
            toolcall: caps.toolcall === true,
            input: mode?.input ?? ['text'],
            output: mode?.output ?? ['text'],
          },
        } : {}),
        variants: Object.keys(record(model.variants)),
      });
    }
  }
  return { models, connected, defaults, providers };
}

function preferredCandidate(candidates: OpenCodeModelInfo[], wantProvider?: string): OpenCodeModelInfo | undefined {
  if (!candidates.length) return undefined;
  if (wantProvider) {
    const exact = candidates.filter(model => model.providerID === wantProvider);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return undefined;
    const lower = wantProvider.toLowerCase();
    const ci = candidates.filter(model => model.providerID.toLowerCase() === lower);
    if (ci.length === 1) return ci[0];
    if (ci.length > 1) return undefined;
  }
  const go = candidates.filter(model => model.providerID === 'opencode-go');
  if (go.length === 1) return go[0];
  const zen = candidates.filter(model => model.providerID === 'opencode');
  if (zen.length === 1) return zen[0];
  return candidates.length === 1 ? candidates[0] : undefined;
}

function familySibling(all: OpenCodeModelInfo[], ref: string, wantProvider: string): OpenCodeModelInfo | undefined {
  const lower = ref.toLowerCase();
  const family = all.filter(model => model.modelID === ref || model.modelID.toLowerCase() === lower);
  if (!family.length) return undefined;
  const names = new Set(family.map(model => model.name?.toLowerCase()).filter((x): x is string => !!x));
  if (!names.size) return undefined;
  const candidates = all.filter(model =>
    model.providerID.toLowerCase() === wantProvider.toLowerCase() &&
    !!model.name && names.has(model.name.toLowerCase()),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function fuzzyFamilyResolve(all: OpenCodeModelInfo[], ref: string, wantProvider?: string): OpenCodeModelInfo | undefined {
  const tokens = ref.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 1);
  if (tokens.length < 2) return undefined;
  const minimum = Math.max(2, Math.ceil(tokens.length / 2));
  const scored = all
    .filter(model => !wantProvider || model.providerID.toLowerCase() === wantProvider.toLowerCase())
    .map(model => ({
      model,
      score: tokens.filter(token => `${model.modelID} ${model.name ?? ''} ${model.family ?? ''}`.toLowerCase().includes(token)).length,
    }))
    .filter(row => row.score >= minimum)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return undefined;
  const top = scored.filter(row => row.score === scored[0]!.score).map(row => row.model);
  return preferredCandidate(top, wantProvider);
}

export interface ModelResolution {
  model?: OpenCodeModelInfo;
  candidates?: OpenCodeModelInfo[];
  reason?: string;
}

/**
 * Resolve the sloppy model references agents naturally produce while refusing
 * ambiguous multi-account/provider matches. Exact ids win, then display names,
 * then the OpenSwarm family fallback. A bad guess is worse than no selection.
 */
export function resolveModel(
  all: OpenCodeModelInfo[],
  input: { providerID?: string; modelID?: string },
): ModelResolution {
  const requestedProvider = input.providerID?.trim() ? normalizeProvider(input.providerID) : undefined;
  const requestedModel = input.modelID?.trim();
  if (!requestedProvider && !requestedModel) return { reason: 'No model reference was supplied.' };

  const scope = requestedProvider
    ? all.filter(model => model.providerID.toLowerCase() === requestedProvider.toLowerCase())
    : all;

  if (requestedModel) {
    const exact = scope.filter(model => model.modelID === requestedModel);
    const exactChoice = preferredCandidate(exact, requestedProvider);
    if (exactChoice) return { model: exactChoice };
    if (exact.length > 1) return { candidates: exact, reason: 'The model id is ambiguous across available routes.' };

    const lower = requestedModel.toLowerCase();
    const ci = scope.filter(model => model.modelID.toLowerCase() === lower);
    const ciChoice = preferredCandidate(ci, requestedProvider);
    if (ciChoice) return { model: ciChoice };
    if (ci.length > 1) return { candidates: ci, reason: 'The model id matches multiple available routes.' };

    const byName = scope.filter(model => model.name?.toLowerCase() === lower);
    const nameChoice = preferredCandidate(byName, requestedProvider);
    if (nameChoice) return { model: nameChoice };
    if (byName.length > 1) return { candidates: byName, reason: 'The display name matches multiple provider/account routes.' };

    if (requestedProvider) {
      const sibling = familySibling(all, requestedModel, requestedProvider);
      if (sibling) return { model: sibling };
    }
    const fuzzy = fuzzyFamilyResolve(all, requestedModel, requestedProvider);
    if (fuzzy) return { model: fuzzy };
  }
  return { reason: `No available model matches ${requestedProvider ? `${requestedProvider}/` : ''}${requestedModel ?? ''}.` };
}

function normalizeVariant(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

const VARIANT_ALIASES: Record<string, string[]> = {
  default: ['default', 'base', 'normal'],
  xhigh: ['xhigh', 'extrahigh', 'veryhigh'],
  max: ['max', 'maximum'],
  high: ['high'],
  medium: ['medium', 'med'],
  low: ['low'],
  minimal: ['minimal', 'minimum'],
  none: ['none', 'off'],
};

export function resolveVariant(model: OpenCodeModelInfo, requested?: string): { variant?: string; published: string[]; reason?: string } {
  if (!requested?.trim()) return { published: model.variants ?? [] };
  const published = model.variants ?? [];
  const wanted = requested.trim();
  if (wanted.toLowerCase() === 'default' || normalizeVariant(wanted) === 'base' || normalizeVariant(wanted) === 'normal') {
    return { variant: 'default', published };
  }
  const exact = published.find(value => value === wanted);
  if (exact) return { variant: exact, published };
  const ci = published.find(value => value.toLowerCase() === wanted.toLowerCase());
  if (ci) return { variant: ci, published };
  const normalized = normalizeVariant(wanted);
  const direct = published.filter(value => normalizeVariant(value) === normalized);
  if (direct.length === 1) return { variant: direct[0], published };
  for (const [canonical, aliases] of Object.entries(VARIANT_ALIASES)) {
    if (!aliases.includes(normalized)) continue;
    const hits = published.filter(value => normalizeVariant(value) === normalizeVariant(canonical));
    if (hits.length === 1) return { variant: hits[0], published };
  }
  if (!published.length) {
    return { reason: `The selected model does not publish reasoning variants; omit variant instead of guessing.`, published };
  }
  return { reason: `Variant "${wanted}" is not published for ${model.providerID}/${model.modelID}. Available: default, ${published.join(', ')}.`, published };
}

export function hasCapability(model: OpenCodeModelInfo, capability: ModelCapability): boolean {
  if (capability === 'text') return true;
  return model.capabilities?.input.includes(capability) === true;
}

export function modelInputPrice(model: OpenCodeModelInfo): number {
  return typeof model.cost?.input === 'number' ? model.cost.input : Number.POSITIVE_INFINITY;
}

export function modelsWithCapability(models: OpenCodeModelInfo[], capability: ModelCapability): OpenCodeModelInfo[] {
  return models.filter(model => hasCapability(model, capability)).sort((a, b) => {
    const aPrice = modelInputPrice(a);
    const bPrice = modelInputPrice(b);
    if (aPrice !== bPrice) return aPrice - bPrice;
    const tier = (model: OpenCodeModelInfo) => model.tier === 'zen-free' ? 0 : model.tier === 'go' ? 1 : 2;
    return tier(a) - tier(b);
  });
}
