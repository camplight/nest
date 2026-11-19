import {expect, it} from 'vitest';
import {describeModelReference, modelProviderLabel} from './models';

it('names openai-compatible providers from the base URL, else the Fireworks model path', () => {
  expect(modelProviderLabel('openai-compatible', 'any/model', 'https://api.fireworks.ai/inference/v1')).toBe('Fireworks');
  expect(modelProviderLabel('openai-compatible', 'accounts/fireworks/models/glm-5p3', 'https://llm.example/v1')).toBe('OpenAI-compatible');
  expect(modelProviderLabel('openai-compatible', 'accounts/fireworks/models/glm-5p3')).toBe('Fireworks');
  expect(modelProviderLabel('openai-compatible', 'local-model')).toBe('OpenAI-compatible');
  expect(modelProviderLabel('openrouter')).toBe('OpenRouter');
  expect(modelProviderLabel('mystery')).toBe('mystery');
});

it('describes references for display', () => {
  expect(describeModelReference('openai-compatible:accounts/fireworks/models/glm-5p3')).toEqual({name: 'glm-5p3', provider: 'Fireworks'});
  expect(describeModelReference('openrouter:z-ai/glm-5.3')).toEqual({name: 'z-ai/glm-5.3', provider: 'OpenRouter'});
  expect(describeModelReference('custom')).toEqual({name: 'custom', provider: ''});
});
