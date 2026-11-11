export type PlannerDraftConfig = {
  name: string
  avatar: string
  providerId: string
  model: string
}

export type PlannerSavedConfig = {
  name: string
  avatar: string
  providerId: string
  model: string | null
}

/** 判断 Planner 表单是否与已保存配置一致；空模型按 null 处理，名字按保存时的 trim 口径比较。 */
export function plannerDraftMatches(draft: PlannerDraftConfig, saved: PlannerSavedConfig): boolean {
  const model = draft.model.trim() === '' ? null : draft.model.trim()
  return (
    draft.providerId === saved.providerId &&
    model === saved.model &&
    draft.name.trim() === saved.name &&
    draft.avatar === saved.avatar
  )
}
