import { describe, expect, it } from 'vitest';
import { tgHtml, tgPlain } from './tg-format.ts';

describe('разметка рассылок', () => {
  it('жирный, курсив, подчёркнутый, зачёркнутый, ссылка; остальное экранируется', () => {
    expect(tgHtml('**Важно** <тест> & *курсив* __подч__ ~~нет~~ [сайт](https://a.by/x?a=1&b=2)')).toBe(
      '<b>Важно</b> &lt;тест&gt; &amp; <i>курсив</i> <u>подч</u> <s>нет</s> <a href="https://a.by/x?a=1&amp;b=2">сайт</a>',
    );
  });
  it('не трогает списки, умножение, ники и незакрытые маркеры', () => {
    expect(tgHtml('* пункт\n2*3*4\n@step_of_faith_2026_bot\n**не закрыт')).toBe('* пункт\n2*3*4\n@step_of_faith_2026_bot\n**не закрыт');
  });
  it('ссылки только http(s) и tg', () => {
    expect(tgHtml('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))');
  });
  it('без разметки - для заголовка объявления', () => {
    expect(tgPlain('**Обед** в __14:00__ [тут](https://a.by)')).toBe('Обед в 14:00 тут (https://a.by)');
  });
});
