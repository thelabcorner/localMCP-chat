import { describe, expect, it } from 'vitest';
import {
  catalogFromProviderPayload,
  modelsWithCapability,
  resolveModel,
  resolveVariant,
} from '../../main/integrations/opencode/model-catalog.js';

function catalog() {
  return catalogFromProviderPayload({
    connected: ['opencode-go', 'opencode', 'workbuddy', 'openrouter'],
    default: { 'opencode-go': 'muse-1.3-spark' },
    all: [
      {
        id: 'opencode-go',
        models: {
          'muse-1.3-spark': {
            id: 'muse-1.3-spark',
            name: 'Muse 1.3 Spark',
            family: 'muse',
            cost: { input: 0.2, output: 1.0, cache: { read: 0.02, write: 0.2 } },
            limit: { context: 262144, output: 32768 },
            capabilities: {
              reasoning: true,
              attachment: true,
              toolcall: true,
              input: { text: true, image: true, pdf: true, audio: false, video: false },
              output: { text: true, image: false, pdf: false, audio: false, video: false },
            },
            variants: { low: {}, medium: {}, high: {}, xhigh: {} },
          },
        },
      },
      {
        id: 'opencode',
        models: {
          'muse-spark-free': {
            id: 'muse-spark-free',
            name: 'Muse 1.3 Spark',
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            capabilities: { input: { text: true, image: true, pdf: false }, output: { text: true } },
            variants: { high: {}, max: {} },
          },
        },
      },
      {
        id: 'workbuddy',
        models: {
          'claude-sonnet@acct-a': { id: 'claude-sonnet@acct-a', name: 'Claude Sonnet (a@example.test)', variants: { high: {} } },
          'claude-sonnet@acct-b': { id: 'claude-sonnet@acct-b', name: 'Claude Sonnet (b@example.test)', variants: { high: {} } },
        },
      },
      {
        id: 'openrouter',
        models: {
          'anthropic/claude-sonnet': { id: 'anthropic/claude-sonnet', name: 'Claude Sonnet', variants: { low: {}, high: {} } },
        },
      },
    ],
  });
}

describe('OpenCode live model catalog', () => {
  it('preserves provider topology, price/capability metadata, and dynamic variants', () => {
    const value = catalog();
    const muse = value.models.find(model => model.providerID === 'opencode-go' && model.modelID === 'muse-1.3-spark')!;
    expect(muse.tier).toBe('go');
    expect(muse.cost).toMatchObject({ input: 0.2, output: 1, cacheRead: 0.02, cacheWrite: 0.2 });
    expect(muse.contextLimit).toBe(262144);
    expect(muse.capabilities?.input).toEqual(expect.arrayContaining(['text', 'image', 'pdf']));
    expect(muse.variants).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('resolves tier aliases and human display names but refuses ambiguous provider/account choices', () => {
    const { models } = catalog();
    expect(resolveModel(models, { providerID: 'go', modelID: 'Muse 1.3 Spark' }).model).toMatchObject({
      providerID: 'opencode-go', modelID: 'muse-1.3-spark',
    });
    expect(resolveModel(models, { providerID: 'workbuddy', modelID: 'claude-sonnet@acct-b' }).model).toMatchObject({
      providerID: 'workbuddy', modelID: 'claude-sonnet@acct-b',
    });
    expect(resolveModel(models, { modelID: 'Claude Sonnet' }).model).toMatchObject({
      providerID: 'openrouter', modelID: 'anthropic/claude-sonnet',
    });
    const ambiguousModels = [
      ...models,
      { providerID: 'workbuddy', modelID: 'same-name@acct-a', name: 'Same Routed Model', tier: 'workbuddy' },
      { providerID: 'workbuddy', modelID: 'same-name@acct-b', name: 'Same Routed Model', tier: 'workbuddy' },
    ];
    const ambiguous = resolveModel(ambiguousModels, { providerID: 'workbuddy', modelID: 'Same Routed Model' });
    expect(ambiguous.model).toBeUndefined();
    expect(ambiguous.reason).toMatch(/multiple|ambiguous/i);
  });

  it('maps human extra-high wording to xhigh only when the selected model publishes xhigh', () => {
    const { models } = catalog();
    const go = models.find(model => model.providerID === 'opencode-go')!;
    const zen = models.find(model => model.providerID === 'opencode')!;
    expect(resolveVariant(go, 'extra high')).toMatchObject({ variant: 'xhigh' });
    const refused = resolveVariant(zen, 'extra high');
    expect(refused.variant).toBeUndefined();
    expect(refused.reason).toMatch(/not published/i);
  });

  it('uses the live capability catalog for cheapest-capable delegation', () => {
    const ranked = modelsWithCapability([
      ...catalog().models,
      { providerID: 'custom', modelID: 'unknown-price-vision', tier: 'custom', capabilities: { input: ['text', 'image'], output: ['text'] } },
    ], 'image');
    expect(ranked.map(model => `${model.providerID}/${model.modelID}`)).toEqual([
      'opencode/muse-spark-free',
      'opencode-go/muse-1.3-spark',
      'custom/unknown-price-vision',
    ]);
  });
});
