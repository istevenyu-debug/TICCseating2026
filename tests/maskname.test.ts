import { expect, it } from 'vitest';
import { maskName } from '@/lib/notify';

it('劃位成功信的出席貴賓：中文留前後字，英文留名字＋姓的首字', () => {
  expect(maskName('王大明')).toBe('王○明');
  expect(maskName('王明')).toBe('王○');
  expect(maskName('歐陽小明')).toBe('歐○○明');
  expect(maskName('王大明02')).toBe('王○明02');
  expect(maskName('John Smith')).toBe('John S.');
  expect(maskName('mary ann o\'neil')).toBe('mary O.');
  expect(maskName('John Smith02')).toBe('John S.02');
  expect(maskName('John')).toBe('J○○n');
  expect(maskName('Mary 王')).toBe('M○○○○王');
});
