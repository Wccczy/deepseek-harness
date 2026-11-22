/* zcode-workflow
name: repo-overview
description: 三个切面并行勘察仓库（目录布局、提交历史、文档体系），汇总产出一份速览报告，适合演示 workflow 时间线 UI
whenToUse: 想要一份仓库速览，或想看 workflow 时间线效果时
scope: project
*/

interface ScoutResult {
  /** 一段不超过 150 字的中文摘要。 */
  summary: string;
  /** 3 到 5 条具体发现，每条一句话，引用真实路径。 */
  highlights: string[];
}

interface ReportSection {
  /** 小节标题。 */
  heading: string;
  /** 这一节的具体要点，每条一句话。 */
  points: string[];
}

interface OverviewReport {
  /** 报告标题。 */
  title: string;
  /** 两三句的总览。 */
  overview: string;
  /** 按切面分节整理的要点。 */
  sections: ReportSection[];
}

const aspects = [
  {
    name: "布局勘察员",
    task: "勘察本仓库的顶层目录结构，以及 packages/ 下的分组方式，说明每个目录的用途。",
  },
  {
    name: "历史勘察员",
    task: "用 git 历史总结最近 20 次提交的工作方向，并指出当前分支的主题。",
  },
  {
    name: "文档勘察员",
    task: "浏览 docs/ 目录，概括文档体系如何组织，新人应按什么顺序阅读。",
  },
];

log(`三个切面并行勘察：${aspects.map((a) => a.name).join("、")}`);

phase("并行勘察仓库的三个切面");
const discovered = await Promise.all(
  aspects.map(async (a) => {
    const result = await agent(a.name, "你是仓库勘察员。用中文回答，结论具体，引用真实路径，不要编造。").ask<ScoutResult>(
      `${a.task}\n\n把发现整理为 summary 和 highlights 返回。`,
    );
    report({ aspect: a.name, summary: result.summary });
    return result;
  }),
);

phase("核对最近提交记录");
const recent = await world.run("git", ["log", "--oneline", "-10"]);

phase("汇总并产出速览报告");
const editor = agent(
  "汇总编辑",
  "你是编辑。把多位勘察员的发现合成一份连贯、准确的中文速览报告，不要新增未经提供的结论。",
);
const overview = await editor.ask<OverviewReport>(
  `以下是三位勘察员的发现和最近 10 条提交记录，请汇总成一份速览报告：\n\n勘察发现：\n${JSON.stringify(
    aspects.map((a, i) => ({ aspect: a.name, result: discovered[i] })),
  )}\n\n最近提交：\n${recent.stdout}`,
);

const markdown = [
  `# ${overview.title}`,
  "",
  overview.overview,
  "",
  ...overview.sections.flatMap((s) => [
    `## ${s.heading}`,
    "",
    ...s.points.map((p) => `- ${p}`),
    "",
  ]),
].join("\n");
await artifact.markdown("overview", markdown, {
  title: "仓库速览报告",
  description: "三个切面并行勘察后的汇总报告。",
  primary: true,
});

return {
  conclusion: `仓库速览完成：${overview.overview}`,
  verified: ["git log 最近 10 条提交由脚本直接运行核对；三个切面由独立子代理分别阅读仓库得出"],
  notCovered: ["演示性速览，未深入任何模块的实现细节"],
};
