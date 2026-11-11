const TOOL_LABELS: Record<string, string> = {
  Bash: '命令',
  Read: '读取',
  Write: '写入',
  Edit: '编辑',
  MultiEdit: '批量编辑',
  NotebookEdit: '编辑笔记本',
  Glob: '查找文件',
  Grep: '搜索内容',
  WebFetch: '抓取网页',
  WebSearch: '搜索网页',
  Skill: '技能',
  Task: '子任务',
  TodoWrite: '更新计划',
}

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name
}
