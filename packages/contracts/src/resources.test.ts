import { describe, expect, test } from 'vitest';
import { resourceTypes, tabs } from './resources';
import { releasedResource } from './routes/releases';
import { topicTab } from './routes/topics';

describe('shared resource-type and tab lists', () => {
  test('the release contract enums equal resourceTypes and tabs', () => {
    expect(releasedResource.shape.type.options).toEqual([...resourceTypes]);
    expect(releasedResource.shape.tab.options).toEqual([...tabs]);
    expect(topicTab.options).toEqual([...tabs]);
  });
});
