#!/usr/bin/env node
/* 文本解析回归测试：广告过滤、卷首元信息、分卷与章节切分。
   期望值全部手写，不调用被测函数生成。

   这些规则错起来都很安静 —— 少识别一行广告只是抄写时多打几个字，
   但把正文当广告吃掉是不可逆的，所以每条规则都要有断言兜着。

   用法: node verify/test-text.js
*/
(async () => {
  const { parseNovel, isAdLine, isVolumeHeading, isChapterHeading, finalizeChapters, indentContent } =
    await import('../src/core/text.js');

  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || {} });
  const eq = (name, actual, expected) => record(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    { actual, expected },
  );

  /* ── 示例：盗版站导出的 txt，广告 + 书名 + 作者 + 简介 + 分卷 + 两章 ── */
  const SAMPLE = [
    '==========================================================',
    '更多精校小说尽在知轩藏书下载：https://zxcs.zip/',
    '==========================================================',
    '奥术神座',
    '作者：爱潜水的乌贼',
    '',
    '',
    '内容简介：',
    '　　“知识就等于力量。”',
    '　　“所谓神，不过是强大一点的奥术师。”',
    '　　带着一大堆知识的夏风穿越而来了。',
    '',
    '',
    '第一部 圣咏之城',
    '',
    '',
    '第一章 燃烧的火刑架',
    '　　浓烟滚滚，每吸一口都发出破烂风箱般粗重的声音，像是在灼烧着咽喉和肺部。',
    '　　“不能，不能睡过去，会死的。”',
    '',
    '',
    '第二章 火刑架上的记忆',
    '　　夏风醒了过来。',
    '',
    '',
    '第二部 守夜人',
    '',
    '',
    '第三章 新的开始',
    '　　他走进了那扇门。',
  ].join('\n');

  /* ── 广告识别 ── */
  record('分隔线算广告', isAdLine('=========================================================='), {});
  record('短行里的推广网址算广告', isAdLine('更多精校小说尽在知轩藏书下载：https://zxcs.zip/'), {});
  record('站点名算广告', isAdLine('笔趣阁无弹窗最新章节'), {});
  record('推广动作 + 作品对象同时出现才算广告', isAdLine('全集下载小说txt'), {});
  record('只是提到"下载"不算广告（缺作品对象）', !isAdLine('他点了下载按钮。'), {});
  record('正文长行里出现"下载"不误杀（宁可放过不可误杀）',
    !isAdLine('李善德翻开那本从网上下载来的旧档案，纸页已经发黄，边角还留着前人的批注，字迹密密麻麻。'), {});
  record('普通正文行不是广告', !isAdLine('　　浓烟滚滚，每吸一口都发出破烂风箱般粗重的声音。'), {});
  record('空行不是广告', !isAdLine('   '), {});

  /* ── 分卷与章节 ── */
  record('第X部是分卷', isVolumeHeading('第一部 圣咏之城'), {});
  record('第X卷是分卷', isVolumeHeading('第二卷 风起'), {});
  record('卷X是分卷', isVolumeHeading('卷三'), {});
  record('第X章是章节，不是分卷', !isVolumeHeading('第一章 燃烧的火刑架') && isChapterHeading('第一章 燃烧的火刑架'), {});

  /* ── 整篇解析 ── */
  const parsed = parseNovel(SAMPLE);
  eq('书名识别正确', parsed.title, '奥术神座');
  eq('作者识别正确', parsed.author, '爱潜水的乌贼');
  eq('简介收全（三段，不含空行）', parsed.summary.split('\n'), [
    '“知识就等于力量。”',
    '“所谓神，不过是强大一点的奥术师。”',
    '带着一大堆知识的夏风穿越而来了。',
  ]);
  record('广告没有混进任何章节', !JSON.stringify(parsed.chapters).includes('知轩藏书')
    && !JSON.stringify(parsed.chapters).includes('zxcs.zip'), { chapters: parsed.chapters.length });
  eq('章节数正确（卷标不算章节）', parsed.chapters.length, 3);
  eq('章节标题与所属卷（前半）',
    parsed.chapters.slice(0, 2).map(item => [item.title, item.volume]),
    [['第一章 燃烧的火刑架', '第一部 圣咏之城'], ['第二章 火刑架上的记忆', '第一部 圣咏之城']]);
  eq('换卷后章节挂到新卷上',
    [parsed.chapters[2].title, parsed.chapters[2].volume],
    ['第三章 新的开始', '第二部 守夜人']);
  record('章节正文不含书名/作者/简介',
    !JSON.stringify(parsed.chapters).includes('奥术神座')
    && !JSON.stringify(parsed.chapters).includes('爱潜水的乌贼')
    && !JSON.stringify(parsed.chapters).includes('知识就等于力量'), {});
  record('章节正文保留了原文（含那句对话）',
    parsed.chapters[0].parts.join('\n').includes('不能，不能睡过去，会死的'), {});
  record('卷首没有产生多余的"卷首"章节（元信息都被识别了）',
    !parsed.chapters.some(item => item.title === '卷首'), { titles: parsed.chapters.map(item => item.title) });

  /* ── 没有章节的纯文本：一个字都不能少 ── */
  const plain = parseNovel('这是一篇没有章节标题的短文。\n第二行也还是正文。');
  eq('没有章节标题时整体作为一个章节', plain.chapters.length, 1);
  eq('整篇内容原样保留', plain.chapters[0].parts.join('\n'), '这是一篇没有章节标题的短文。\n第二行也还是正文。');

  /* ── 卷首区里没认出来的行：留着，不丢 ── */
  const messy = parseNovel([
    '某本书',
    '类型：玄幻',
    '字数：120万',
    '',
    '第一章 开端',
    '　　正文从这里开始。',
  ].join('\n'));
  eq('书名叫对了', messy.title, '某本书');
  record('没认出来的卷首行组成「卷首」章节（不丢内容）',
    messy.chapters.some(item => item.title === '卷首' && item.parts.join('\n').includes('类型：玄幻')),
    { titles: messy.chapters.map(item => item.title) });

  /* ── 卷标后直接跟正文（少见但要接住）── */
  const volumeFirst = parseNovel('第二部 风起\n　　卷标下面直接是正文。\n第一章 之后才是章');
  eq('卷标下的散内容挂在本卷名下', volumeFirst.chapters[0].title, '第二部 风起');
  eq('它继承了这一卷', volumeFirst.chapters[0].volume, '第二部 风起');

  /* ── 定稿与缩进 ── */
  const finalized = finalizeChapters(parsed.chapters);
  eq('定稿后卷标仍在', finalized.map(item => item.volume),
    ['第一部 圣咏之城', '第一部 圣咏之城', '第二部 守夜人']);
  record('定稿后每章都有正文', finalized.every(item => item.content.length > 0), {});
  record('补缩进后正文首行是两个全角空格（正文本身没有缩进时）',
    indentContent('浓烟滚滚。').startsWith('\u3000\u3000'), {});
  record('补缩进不会动已有的缩进行',
    indentContent('\u3000\u3000浓烟滚滚。') === '\u3000\u3000浓烟滚滚。', {});

  const failed = checks.filter(item => !item.ok);
  const result = {
    ok: failed.length === 0,
    passed: checks.length - failed.length,
    total: checks.length,
    failed: failed.map(item => item.name),
    checks: failed,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(failed.length ? 1 : 0);
})();
